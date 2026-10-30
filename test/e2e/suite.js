// Runs inside the VS Code extension host on the refactored root runTest.js made: plan, quick fix, Write & re-plan.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

async function step(name, fn) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
  } catch (e) {
    console.log(`  ✘ ${name}: ${e && e.stack ? e.stack : e}`);
    throw e;
  }
}

const until = async (what, fn, ms = 180000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** Plan Lens quick fixes on the line of a block header. */
async function fixes(uri, header) {
  const doc = await vscode.workspace.openTextDocument(uri);
  const line = doc.getText().split('\n').findIndex((l) => l.startsWith(header));
  const all = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', uri, new vscode.Range(line, 0, line, 0));
  return (all || []).filter((a) => a.title.startsWith('Plan Lens'));
}

exports.run = async function () {
  const ws = process.env.PLAN_LENS_E2E;
  const main = vscode.Uri.file(path.join(ws, 'main.tf'));
  const moved = path.join(ws, 'moved.tf');
  const ext = vscode.extensions.getExtension('jay-boo.tf-plan-lens');

  await step('activates and plans the folder with no setup', async () => {
    await ext.activate();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(main));
    // One plain root, picked by itself: Run plan needs no picker.
    await vscode.commands.executeCommand('planLens.runPlan');
    await until('the plan', async () => (await fixes(main, 'module "storage"')).length > 0);
  });

  /** Hover text on the line starting with `prefix` (or at a range), once values are in. */
  const hoverAt = async (uri, where) => {
    const doc = await vscode.workspace.openTextDocument(uri);
    const pos = typeof where === 'string' ? new vscode.Position(doc.getText().split('\n').findIndex((l) => l.trimStart().startsWith(where)), 4) : where;
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, pos);
    return (hovers || []).flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
  };

  await step('inline values: a local, a for expression, for_each instances', async () => {
    await until('the value of local.prefix', async () => /"rg-qual-data"/.test(await hoverAt(main, 'prefix')), 240000);
    assert.match(await hoverAt(main, 'cidrs'), /app = "10\.0\.0\.0\/24"/);
    assert.match(await hoverAt(main, 'for_each = { app'), /3 instances: "app", "db", "pe"/);
  });

  await step('Evaluate selection: a value, then an error', async () => {
    const doc = await vscode.workspace.openTextDocument(main);
    const editor = await vscode.window.showTextDocument(doc);
    const line = doc.getText().split('\n').findIndex((l) => l.trimStart().startsWith('prefix'));
    const from = doc.lineAt(line).text.indexOf('"rg-');
    editor.selection = new vscode.Selection(line, from, line, doc.lineAt(line).text.length);
    await vscode.commands.executeCommand('planLens.evaluateSelection');
    assert.match(await hoverAt(main, editor.selection.active), /"rg-qual-data"/);
    // A reference that does not exist: terraform's own message.
    await editor.edit((b) => b.insert(new vscode.Position(line, doc.lineAt(line).text.length), ' # local.nope'));
    const at = doc.lineAt(line).text.indexOf('local.nope');
    editor.selection = new vscode.Selection(line, at, line, at + 'local.nope'.length);
    await vscode.commands.executeCommand('planLens.evaluateSelection');
    assert.match(await hoverAt(main, editor.selection.active), /undeclared local value/i);
    await vscode.commands.executeCommand('undo');
    await doc.save();
  });

  await step('completions from the data: local.cidrs. and local.cidrs["', async () => {
    const doc = await vscode.workspace.openTextDocument(main);
    const editor = await vscode.window.showTextDocument(doc);
    const line = doc.getText().split('\n').findIndex((l) => l.trimStart().startsWith('cidrs'));
    const labels = async (text) => {
      await editor.edit((b) => b.insert(new vscode.Position(line + 1, 0), `  probe = ${text}\n`));
      const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', main, new vscode.Position(line + 1, `  probe = ${text}`.length), text.endsWith('.') ? '.' : '"');
      await vscode.commands.executeCommand('undo');
      return list.items.filter((i) => i.detail && i.detail.includes('Plan Lens')).map((i) => `${typeof i.label === 'string' ? i.label : i.label.label}:${i.insertText}`);
    };
    assert.deepEqual(await labels('local.cidrs.'), ['app:app', 'db:db']);
    assert.deepEqual(await labels('local.cidrs["'), ['app:app"]', 'db:db"]']);
    await doc.save();
  });

  await step('quick fix on module "storage": keep terraform_data.lake', async () => {
    const [fix, ...rest] = await fixes(main, 'module "storage"');
    assert.match(fix.title, /^Plan Lens: keep terraform_data\.lake \(add moved block, 100% match\)$/);
    assert.equal(rest.length, 0);
    assert.equal(fix.isPreferred, true);
    await vscode.commands.executeCommand(fix.command.command, ...fix.command.arguments);
    const text = fs.readFileSync(moved, 'utf8');
    assert.match(text, /^# Plan Lens · .*: 1 destroy kept as move\nmoved \{\n  from = terraform_data\.lake\n  to   = module\.storage\.terraform_data\.this\n\}\n$/);
  });

  await step('the subnet block offers all three count → for_each moves', async () => {
    const titles = (await fixes(main, 'resource "terraform_data" "subnet"')).map((f) => f.title);
    assert.deepEqual(titles, [
      'Plan Lens: keep terraform_data.subnet[0] (add moved block, 100% match)',
      'Plan Lens: keep terraform_data.subnet[1] (add moved block, 100% match)',
      'Plan Lens: keep terraform_data.subnet[2] (add moved block, 100% match)',
      'Plan Lens: keep all 3 (add moved blocks, then re-plan)',
    ]);
  });

  await step('Write & re-plan with every move: lake not written twice, module moves folded', async () => {
    const ids = new Set();
    for (const header of ['module "storage"', 'resource "terraform_data" "subnet"', 'module "new"', 'module "inst"']) {
      for (const f of await fixes(main, header)) f.command.arguments[0].forEach((id) => ids.add(id));
    }
    assert.equal(ids.size, 7);
    await vscode.commands.executeCommand('planLens.writeMoves', [...ids], true);
    const text = fs.readFileSync(moved, 'utf8');
    assert.equal((text.match(/from = terraform_data\.lake\n/g) || []).length, 1);
    assert.equal((text.match(/^moved \{/gm) || []).length, 7);
    assert.match(text, /from = module\.old\n  to   = module\.new\n/);
    assert.match(text, /from = module\.inst\[0\]\n  to   = module\.inst\["i0"\]\n/);
    // The re-plan lands: the objects moved, so nothing is offered any more.
    await until('the re-plan', async () => (await fixes(main, 'module "storage"')).length === 0 && (await fixes(main, 'module "new"')).length === 0);
  });

  await step('preview on save: an edited block says it will be replaced, before any plan', async () => {
    const doc = await vscode.workspace.openTextDocument(main);
    const editor = await vscode.window.showTextDocument(doc);
    const line = doc.getText().split('\n').findIndex((l) => l.startsWith('resource "terraform_data" "keep"'));
    const old = doc.lineAt(line).text;
    await editor.edit((b) => b.replace(doc.lineAt(line).range, 'resource "terraform_data" "keep" {\n  input            = "same"\n  triggers_replace = ["v2"]\n}'));
    await doc.save();
    const hover = async () => {
      const hs = await vscode.commands.executeCommand('vscode.executeHoverProvider', main, new vscode.Position(line, 3));
      return (hs || []).flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
    };
    await until('the preview', async () => /Preview of your edit/.test(await hover()), 120000);
    const text = await hover();
    assert.match(text, /\*\*Replace\*\*/);
    assert.match(text, /forces replace/);
    // Back as it was, so the final terraform check sees the refactor alone.
    await editor.edit((b) => b.replace(new vscode.Range(line, 0, line + 3, doc.lineAt(line + 3).text.length), old));
    await doc.save();
  });
};
