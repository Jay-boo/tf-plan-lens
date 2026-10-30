// The README scenes. Each starts on a fresh acme-shop (applied on a fresh LocalStack); `setup` prepares what the
// story does not show (a plan already run, values warmed up), `run` is what is recorded.
//   node test/demo/record.mjs [plan refactor values preview] | explore
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WS = path.join(here, 'out/acme-shop');
const README = path.resolve(here, '../../media/readme');

/** Changes a project file on disk (before the scene opens it). */
function edit(file, fn) {
  const p = path.join(WS, file);
  fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8')));
}

/** The edits behind the plan scene: a replace (hash_key), an update, a create and a destroy. */
function planEdits() {
  edit('main.tf', (s) => {
    s = s.replace('hash_key     = "order_id"', 'hash_key     = "id"').replace('    name = "order_id"', '    name = "id"');
    s = s.replace('visibility_timeout_seconds = 60', 'visibility_timeout_seconds = 120');
    s = s.replace('resource "aws_sns_topic" "alerts" {\n  name = "${local.name}-alerts"\n}', 'resource "aws_sns_topic" "alerts" {\n  name = "${local.name}-alerts"\n}\n\nresource "aws_sns_topic" "payments" {\n  name = "${local.name}-payments"\n}');
    return s.slice(0, s.indexOf('resource "aws_iam_role" "worker"')).trimEnd() + '\n';
  });
}

/** The queues moved into a module: terraform would destroy and recreate both. */
function refactorEdits() {
  edit('main.tf', (s) => s.replace(
    'resource "aws_sqs_queue" "orders" {\n  name                       = "${local.name}-orders"\n  visibility_timeout_seconds = 60\n}\n\nresource "aws_sqs_queue" "orders_dlq" {\n  name = "${local.name}-orders-dlq"\n}',
    'module "orders_queue" {\n  source = "./modules/queue"\n  name   = "${local.name}-orders"\n}'));
  edit('outputs.tf', (s) => s.replace('aws_sqs_queue.orders.url', 'module.orders_queue.url'));
}

const sidebar = (d) => d.cmd('Plan Lens: Focus on Plan View', { typeDelay: 0, pause: 500 });
/** A line of the editor, by a piece of its text (no runs of spaces: the editor draws them as no-break spaces). */
const line = (text, dx = 0) => ({ sel: `.view-lines .view-line:has-text(${JSON.stringify(text)})`, at: 'left', dx });

/** Runs a plan of dev from the sidebar's environment list, out of the recording. */
async function planned(d) {
  await sidebar(d);
  await (await d.find('.pl-env-row[title="Plan dev"]')).click();
  // The card's ✓: the plan is in (with or without changes).
  await d.until('.pl-state.ok');
  await d.wait(1500);
}

/** Picks an environment from the sidebar header (no plan). */
async function pick(d, env, { show = false } = {}) {
  if (show) await d.click('.pl-env');
  else await (await d.find('.pl-env')).click();
  await d.pickEnv(env);
}

export const SCENES = {
  // Screenshots of the views, to write scenes.
  explore: {
    record: false,
    async run(d) {
      planEdits();
      await d.open('main.tf');
      await planned(d);
      await d.shot('plan');
    },
  },

  plan: {
    gif: { fps: 10 },
    async setup(d) {
      planEdits();
      await d.open('main.tf');
      await sidebar(d);
      await d.wait(1500);
    },
    async run(d) {
      await d.caption('You changed some Terraform. <b>What will it do?</b>');
      await d.wait(1800);
      await d.click('.pl-env-row[title="Plan dev"]');
      await d.caption('Plan Lens runs the plan…');
      await d.until('.pl-strip');
      await d.caption('…and puts it <b>on your code</b>, risky changes first');
      await d.wait(2600);
      await d.caption('Hover a block: what changes, and what <b>forces the replace</b>');
      await d.hover(line('aws_dynamodb_table', 60), 3600);
      await d.caption();
      await d.move('.pl-orow.k-replace');
      await d.wait(1200);
    },
    async after(d) {
      fs.mkdirSync(README, { recursive: true });
      await d.key('Escape');
      // A still needs no demo cursor or caption.
      await d.page.evaluate(() => document.querySelectorAll('#demo-cursor, #demo-caption').forEach((e) => (e.style.display = 'none')));
      await d.page.mouse.move(1270, 790);
      await d.wait(600);
      await d.shotTo(path.join(README, 'hero.png'));
    },
  },

  refactor: {
    gif: { fps: 10 },
    async setup(d) {
      refactorEdits();
      await d.open('main.tf', 26);
      await planned(d);
    },
    async run(d) {
      await d.caption('Moved two queues into a module: Terraform would <b>destroy and recreate</b> them');
      await d.hover('.pl-moves', 3200);
      await d.caption('Plan Lens sees they are the <b>same queues</b>');
      await d.hover('.pl-mv', 2200);
      await d.click('.pl-moves button.primary');
      await d.caption('It writes the <b>moved blocks</b> and plans again');
      await d.gone('.pl-moves');
      await d.until('.pl-state.ok');
      await d.caption('<b>2 destroys → 0.</b> Nothing recreated.');
      await d.wait(3500);
      await d.caption();
    },
  },

  values: {
    gif: { fps: 10 },
    async setup(d) {
      await d.open('main.tf');
      await sidebar(d);
      await pick(d, 'dev');
      // The first values wait for terraform init in Plan Lens's own copy.
      await d.wait(25000);
      await d.click(line('locals {'));
    },
    async run(d) {
      await d.caption('Your expressions, <b>evaluated</b> for the environment');
      await d.wait(1600);
      await d.hover(line('services = {', 120), 3200);
      await d.caption('Completions from your <b>real data</b>');
      await d.key('Control+G');
      await d.type('39', 80);
      await d.key('Enter');
      await d.wait(500);
      await d.click(line('tostring(each.value.replicas)', 330));
      await d.key('End');
      await d.key('Enter');
      await d.type('description = "port ${each.value.', 60);
      await d.wait(2400);
      await d.type('po', 120);
      await d.wait(700);
      await d.key('Enter');
      await d.type('}"', 60);
      await d.wait(1000);
      await d.caption('Switch to prod: <b>the values follow</b>');
      await pick(d, 'prod', { show: true });
      await d.key('Control+Home');
      await d.wait(7000);
      await d.hover(line('services = {', 120), 3000);
      await d.caption();
    },
  },

  preview: {
    gif: { fps: 10 },
    async setup(d) {
      await d.open('main.tf', 16);
      await planned(d);
    },
    async run(d) {
      await d.caption('Rename the table… is that safe?');
      await d.click(line('-orders"', 300));
      await d.key('End');
      await d.key('ArrowLeft');
      await d.type('-v2', 140);
      await d.wait(600);
      await d.caption('Save: Plan Lens <b>previews just that block</b>');
      await d.key('Control+S');
      await d.wait(9000);
      await d.caption('Before any plan: it would <b>replace the table</b>');
      await d.hover(line('aws_dynamodb_table', 60), 3600);
      await d.caption();
    },
  },
};
