import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePlan } = require('../../out-test/model/planParser.js');
const { toViewModel, ago } = require('../../out-test/model/viewModel.js');

const plan = parsePlan(JSON.parse(readFileSync(new URL('../fixtures/plan.json', import.meta.url), 'utf8')), { env: 'QUAL', source: 'run', loadedAt: 0 });
const located = {
  'module.storage.azurerm_storage_account.this': { file: 'modules/storage_account/main.tf', line: 5 },
  'module.lakebase["fresh"].databricks_database_instance.this': { file: 'modules/lakebase/main.tf', line: 442 },
};
const vm = toViewModel(plan, {
  env: 'QUAL', envs: ['PROD/dev', 'QUAL'], running: false, now: 12 * 60_000, rootName: 'DataPlatformRessources',
  locate: (c) => located[c.address] ?? (c.action === 'create' ? { file: 'main.tf', line: 151 } : undefined),
});

test('header', () => {
  assert.equal(vm.state, 'ready');
  assert.equal(vm.title, 'Plan · QUAL');
  assert.equal(vm.sub, 'DataPlatformRessources · 12 min ago · TF 1.14.7');
  assert.deepEqual(vm.envs, ['PROD/dev', 'QUAL']);
});

test('counts and bar', () => {
  assert.deepEqual(vm.counts, { create: 2, update: 5, replace: 2, destroy: 3, import: 0 });
  assert.equal(vm.unchanged, 2);
  assert.deepEqual(vm.bar.map((b) => b.action), ['create', 'update', 'replace', 'destroy']);
  assert.equal(Math.round(vm.bar.reduce((s, b) => s + b.pct, 0)), 100);
});

test('attention: replace first, then destroy and forget', () => {
  assert.deepEqual(vm.attention.map((i) => i.action), ['replace', 'replace', 'destroy', 'destroy', 'forget']);
  const sa = vm.attention.find((i) => i.address === 'module.storage.azurerm_storage_account.this');
  assert.equal(sa.title, 'azurerm_storage_account.this');
  assert.deepEqual(sa.sub, ['forced by location']);
  assert.equal(sa.module, 'module.storage');
  assert.equal(sa.loc, 'main.tf:6');
  const legacy = vm.attention.find((i) => i.address.endsWith('schema.legacy'));
  assert.equal(legacy.orphan, true);
  assert.deepEqual(legacy.sub, ['removed from code']);
  const fresh = vm.attention.find((i) => i.address.includes('fresh'));
  assert.equal(fresh.module, 'module.lakebase["fresh"]');
  assert.equal(fresh.loc, 'main.tf:443');
  assert.equal(fresh.orphan, false);
  assert.deepEqual(vm.attention.find((i) => i.action === 'forget').sub, ['forget (state only)']);
});

test('titles never carry the module path', () => {
  for (const i of [...vm.attention, ...vm.updates, ...vm.creates, ...vm.reads]) assert.ok(!i.title.includes('module.'), i.title);
  assert.ok(vm.updates.some((i) => i.title === 'azurerm_storage_container.this["raw"]'));
  assert.equal(vm.reads[0].title, 'data.azurerm_client_config.current');
});

test('update sub lists attribute names', () => {
  assert.deepEqual(vm.updates.find((i) => i.title.startsWith('azurerm_storage_container')).sub, ['container_access_type']);
});

test('ago', () => {
  assert.equal(ago(30_000), 'just now');
  assert.equal(ago(5 * 60_000), '5 min ago');
  assert.equal(ago(3 * 3600_000), '3 h ago');
  assert.equal(ago(2 * 86400_000), '2 d ago');
});

test('empty and running', () => {
  const empty = toViewModel(undefined, { envs: ['QUAL'], running: false, now: 0, rootName: 'x', locate: () => undefined });
  assert.equal(empty.state, 'empty');
  assert.equal(empty.attention.length, 0);
  assert.equal(toViewModel(plan, { env: 'QUAL', envs: [], running: true, now: 0, rootName: 'x', locate: () => undefined }).state, 'running');
});

test('loaded file plan', () => {
  const p = { ...plan, env: '', source: '/home/u/Downloads/tfplan.json' };
  const v = toViewModel(p, { envs: [], running: false, now: 0, rootName: 'Root', locate: () => undefined });
  assert.equal(v.title, 'Plan · tfplan.json');
  assert.ok(v.sub.startsWith('tfplan.json · just now'));
  assert.equal(v.loaded, true);
  assert.equal(vm.loaded, false);
});

test('error', () => {
  const v = toViewModel(undefined, { env: 'QUAL', envs: ['QUAL'], running: false, now: 0, rootName: 'x', locate: () => undefined, error: "Error: please run 'az login'" });
  assert.equal(v.error, "Error: please run 'az login'");
  assert.equal(v.state, 'empty');
  assert.equal(vm.error, undefined);
});

test('targeting: a run plan can be targeted, a loaded one cannot', () => {
  assert.equal(vm.canTarget, true);
  assert.deepEqual(vm.targets, []);
  assert.equal(vm.pulled, 0);
  const loaded = toViewModel({ ...plan, env: '', source: '/x/tfplan.json' }, { envs: [], running: false, now: 0, rootName: 'x', locate: () => undefined });
  assert.equal(loaded.canTarget, false);
  assert.equal(toViewModel(plan, { env: 'QUAL', envs: [], running: true, now: 0, rootName: 'x', locate: () => undefined }).canTarget, false);
});

test('targeting: modules to pick from, without data reads', () => {
  assert.deepEqual(vm.modules, [
    { address: 'module.kv', n: 1 },
    { address: 'module.lakebase["fresh"]', n: 1 },
    { address: 'module.lakebase["main"]', n: 1 },
    { address: 'module.remote', n: 1 },
    { address: 'module.storage', n: 3 },
    { address: 'module.unitycatalog', n: 1 },
    { address: 'module.unitycatalog.module.inner', n: 1 },
  ]);
});

test('targeting: a targeted plan marks what terraform pulled in', () => {
  const t = toViewModel({ ...plan, targets: ['module.storage'] }, { env: 'QUAL', envs: [], running: false, now: 0, rootName: 'x', locate: () => undefined });
  assert.deepEqual(t.targets, ['module.storage']);
  const all = [...t.attention, ...t.updates, ...t.creates];
  for (const i of all) assert.equal(!!i.pulled, !i.address.startsWith('module.storage.'), i.address);
  assert.equal(t.pulled, all.filter((i) => i.pulled).length);
  assert.ok(t.reads.every((i) => !i.pulled));
});

test('apply turned off: a run plan with changes still offers Apply (to explain the setting)', () => {
  const o = { env: 'QUAL', envs: [], running: false, now: 0, rootName: 'x', locate: () => undefined };
  assert.equal(toViewModel(plan, { ...o, applyOff: true }).applyOff, true);
  assert.equal(toViewModel(plan, { ...o, applyOff: true, canApply: true }).applyOff, false);
  assert.equal(toViewModel(plan, { ...o, applyOff: true, running: true }).applyOff, false);
  assert.equal(toViewModel({ ...plan, changes: plan.changes.filter((c) => c.action === 'read') }, { ...o, applyOff: true }).applyOff, false);
  assert.equal(vm.applyOff, false);
});

test('running another env: header shows the env being run, not the loaded plan', () => {
  const v = toViewModel(plan, { env: 'QUAL', runEnv: 'PROD/dev', envs: ['PROD/dev', 'QUAL'], running: true, now: 60_000, rootName: 'DataPlatformRessources', locate: () => undefined });
  assert.equal(v.state, 'running');
  assert.equal(v.env, 'PROD/dev');
  assert.equal(v.title, 'Plan · PROD/dev');
  assert.equal(v.sub, '');
  assert.deepEqual(v.counts, { create: 0, update: 0, replace: 0, destroy: 0, import: 0 });
  assert.equal(v.unchanged, 0);
});

test('re-running the same env keeps the previous plan on screen', () => {
  const v = toViewModel(plan, { env: 'QUAL', runEnv: 'QUAL', envs: ['PROD/dev', 'QUAL'], running: true, now: 60_000, rootName: 'DataPlatformRessources', locate: () => undefined });
  assert.equal(v.env, 'QUAL');
  assert.equal(v.title, 'Plan · QUAL');
  assert.equal(v.counts.update, 5);
});

test('refactor moves: listed with match %, destroys tagged with where they move', () => {
  const { findMoves } = require('../../out-test/model/refactor.js');
  const p = parsePlan(JSON.parse(readFileSync(new URL('../fixtures/refactor-plan.json', import.meta.url), 'utf8')), { env: 'QUAL', source: 'run', loadedAt: 0 });
  const opts = { env: 'QUAL', envs: ['QUAL'], running: false, now: 0, rootName: 'root', locate: () => undefined };
  const vm = toViewModel(p, { ...opts, moves: findMoves(p) });
  assert.equal(vm.moves.length, 7);
  assert.equal(vm.movable, 10);
  assert.deepEqual(vm.moves.find((m) => m.from === 'module.old'), { id: 'module.old>module.new', from: 'module.old', to: 'module.new', type: 'module', pct: 100, ambiguous: false, n: 2 });
  assert.equal(vm.attention.find((i) => i.address === 'terraform_data.lake').movesTo, 'module.storage.terraform_data.this');
  assert.equal(vm.attention.find((i) => i.address === 'terraform_data.gone').movesTo, undefined);
  assert.equal(toViewModel(p, { ...opts, moves: findMoves(p), running: true }).moves.length, 0);
});

test('drift, an import replaced right away, a moved object and outputs (real plan)', () => {
  const p = parsePlan(JSON.parse(readFileSync(new URL('../fixtures/rich-plan.json', import.meta.url), 'utf8')), { env: 'QUAL', source: 'run', loadedAt: 0 });
  const v = toViewModel(p, { env: 'QUAL', envs: ['QUAL'], running: false, now: 0, rootName: 'r', locate: () => ({ file: 'main.tf', line: 0 }) });
  assert.deepEqual(v.counts, { create: 1, update: 0, replace: 1, destroy: 0, import: 1 });
  assert.deepEqual(v.drift.map((i) => [i.address, i.sub[0]]), [['local_file.conf', 'deleted outside Terraform']]);
  const imp = v.attention.find((i) => i.address === 'random_string.imp');
  assert.equal(imp.importing, 'abc');
  assert.match(imp.sub[0], /^imported, then replaced/);
  assert.deepEqual(v.movedItems.map((i) => [i.address, i.movedFrom]), [['terraform_data.new_name', 'terraform_data.old_name']]);
  assert.equal(v.unchanged, 0);
  assert.deepEqual(v.outputs.map((o) => `${o.name}:${o.action}`), ['conf_path:update', 'old_output:destroy', 'token:create']);
});

test('an import that changes nothing is listed under imports and can be applied', () => {
  const p = { ...plan, changes: [{ ...plan.changes[0], action: 'noop', importing: 'id-1', attrs: [] }], drift: [], outputs: [] };
  const v = toViewModel(p, { env: 'QUAL', envs: ['QUAL'], running: false, now: 0, rootName: 'r', locate: () => undefined, canApply: true });
  assert.equal(v.imports.length, 1);
  assert.equal(v.unchanged, 0);
  assert.equal(v.canApply, true);
});

test('sections and settings: drift discreet by default, settings override, refactor off hides moves', () => {
  const { findMoves } = require('../../out-test/model/refactor.js');
  const p = parsePlan(JSON.parse(readFileSync(new URL('../fixtures/refactor-plan.json', import.meta.url), 'utf8')), { env: 'QUAL', source: 'run', loadedAt: 0 });
  const opts = { env: 'QUAL', envs: ['QUAL'], running: false, now: 0, rootName: 'r', locate: () => undefined, moves: findMoves(p) };
  const v = toViewModel(p, opts);
  assert.deepEqual(v.sections, { drift: 'discreet', imports: 'shown', moved: 'shown', reads: 'discreet', outputs: 'shown' });
  assert.equal(v.settings.find((s) => s.key === 'allowApply').value, false);
  const w = toViewModel(p, { ...opts, settings: { 'sidebar.drift': 'hidden', 'sidebar.reads': 'nonsense', refactor: false, allowApply: true } });
  assert.equal(w.sections.drift, 'hidden');
  assert.equal(w.sections.reads, 'discreet');
  assert.equal(w.moves.length, 0);
  assert.equal(w.attention.every((i) => !i.movesTo), true);
  assert.equal(w.settings.find((s) => s.key === 'allowApply').value, true);
});
