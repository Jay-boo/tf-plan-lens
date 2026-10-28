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
  assert.deepEqual(vm.counts, { create: 2, update: 5, replace: 2, destroy: 3 });
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
