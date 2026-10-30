import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePlan } = require('../../out-test/model/planParser.js');
const { matchPlan, moduleDirOf } = require('../../out-test/model/matcher.js');

const plan = parsePlan(JSON.parse(readFileSync(new URL('../fixtures/plan.json', import.meta.url), 'utf8')), { env: 'QUAL', source: 'run', loadedAt: 1 });

let line = 0;
const res = (type, name, kind = 'resource') => ({ kind, type, name, startLine: line, endLine: (line += 3) - 1, headerEnd: 10 });
const mod = (name) => ({ kind: 'module', name, startLine: line, endLine: (line += 3) - 1, headerEnd: 10 });

const files = [
  { path: 'main.tf', blocks: [res('databricks_catalog', 'diapason_fresh'), mod('lakebase'), mod('storage'), res('azurerm_client_config', 'current', 'data'), res('databricks_catalog', 'long')] },
  { path: 'roles.tf', blocks: [res('azurerm_role_assignment', 'old'), res('azurerm_client_config', 'current')] },
  { path: 'modules/storage_account/main.tf', blocks: [res('azurerm_storage_account', 'this'), res('azurerm_storage_container', 'this'), res('azurerm_storage_management_policy', 'this')] },
  { path: 'modules/key_vault/main.tf', blocks: [res('azurerm_storage_account', 'this'), res('azurerm_key_vault_secret', 's')] },
  { path: 'modules/lakebase/main.tf', blocks: [res('databricks_database_instance', 'this')] },
  { path: 'modules/databricks_unitycatalog/main.tf', blocks: [res('databricks_schema', 'renamed')] },
  { path: 'modules/shared/grants.tf', blocks: [res('databricks_grants', 'g')] },
];
const { byFile, orphans } = matchPlan(plan, files);
const mark = (file, name, type) => (byFile.get(file) ?? []).find((m) => m.block.name === name && (type === undefined || m.block.type === type));

test('resource in its module folder', () => {
  const m = mark('modules/storage_account/main.tf', 'this', 'azurerm_storage_account');
  assert.equal(m.action, 'replace');
  assert.equal(m.hint, 'replace — forced by location');
  assert.equal(mark('modules/storage_account/main.tf', 'this', 'azurerm_storage_management_policy').hint, 'replace — forced by rule[0].name');
});

test('same name elsewhere not matched', () => {
  assert.equal(mark('modules/key_vault/main.tf', 'this', 'azurerm_storage_account'), undefined);
});

test('instances grouped', () => {
  const m = mark('modules/storage_account/main.tf', 'this', 'azurerm_storage_container');
  assert.equal(m.changes.length, 3);
  assert.equal(m.action, 'update');
  assert.equal(m.hint, '3 instances: 1 update · 2 unchanged');
});

test('module called twice', () => {
  const m = mark('modules/lakebase/main.tf', 'this');
  assert.equal(m.changes.length, 2);
  assert.equal(m.action, 'destroy');
  assert.equal(m.hint, '2 instances: 1 destroy · 1 update');
});

test('module roll-up', () => {
  assert.equal(mark('main.tf', 'lakebase').hint, 'module: 1 destroy · 1 update');
  assert.equal(mark('main.tf', 'lakebase').action, 'destroy');
  assert.equal(mark('main.tf', 'storage').hint, 'module: 2 replace · 1 update');
});

test('single hints', () => {
  assert.equal(mark('main.tf', 'diapason_fresh').hint, 'create');
  assert.equal(mark('main.tf', 'long').hint, 'update · 1 attribute');
  assert.equal(mark('modules/shared/grants.tf', 'g').hint, 'update · 1 attribute');
  assert.equal(mark('main.tf', 'current').hint, 'read');
  assert.equal(mark('roles.tf', 'old').hint, 'forget (state only)');
  assert.equal(mark('modules/key_vault/main.tf', 's').hint, 'update · 1 attribute');
});

test('noop hint', () => {
  const p = { ...plan, changes: plan.changes.filter((c) => c.action === 'noop').map((c) => ({ ...c, address: c.address })) };
  const m = matchPlan(p, [files[2]]).byFile.get('modules/storage_account/main.tf').find((x) => x.block.type === 'azurerm_storage_container');
  assert.equal(m.hint, '2 instances: 2 unchanged');
  const single = { ...p, changes: [p.changes[0]] };
  assert.equal(matchPlan(single, [files[2]]).byFile.get('modules/storage_account/main.tf')[0].hint, 'no changes');
});

test('orphans', () => {
  const addrs = orphans.map((c) => c.address).sort();
  assert.deepEqual(addrs, ['module.remote.azurerm_thing.x', 'module.unitycatalog.databricks_schema.legacy']);
  assert.equal(mark('modules/databricks_unitycatalog/main.tf', 'renamed'), undefined);
});

test('data vs managed', () => {
  assert.equal(mark('main.tf', 'current').changes[0].mode, 'data');
  assert.equal(mark('roles.tf', 'current', 'azurerm_client_config'), undefined);
});

test('moduleDirOf', () => {
  assert.equal(moduleDirOf(plan, []), '');
  assert.equal(moduleDirOf(plan, ['unitycatalog', 'inner']), 'modules/shared');
  assert.equal(moduleDirOf(plan, ['remote']), undefined);
});

test('module source with a trailing slash', () => {
  const p = parsePlan({ format_version: '1.2', resource_changes: [{ address: 'module.s.t.n', module_address: 'module.s', mode: 'managed', type: 't', name: 'n', change: { actions: ['create'], before: null, after: {} } }],
    configuration: { root_module: { module_calls: { s: { source: './modules/s/', module: {} } } } } }, { env: '', source: '', loadedAt: 0 });
  assert.equal(p.moduleDirs.s, 'modules/s');
  const r = matchPlan(p, [{ path: 'modules/s/main.tf', blocks: [{ kind: 'resource', type: 't', name: 'n', startLine: 0, endLine: 1, headerEnd: 1 }] }]);
  assert.equal(r.orphans.length, 0);
});

test('looksLikeOtherRoot', () => {
  const { looksLikeOtherRoot } = require('../../out-test/model/matcher.js');
  const mk = (n) => ({ format_version: '1.2', resource_changes: Array.from({ length: n }, (_, i) => ({ address: `t.r${i}`, mode: 'managed', type: 't', name: `r${i}`, change: { actions: ['update'], before: { a: 1 }, after: { a: 2 } } })) });
  const p = parsePlan(mk(4), { env: '', source: '', loadedAt: 0 });
  const blocks = (k) => Array.from({ length: k }, (_, i) => ({ kind: 'resource', type: 't', name: `r${i}`, startLine: i * 2, endLine: i * 2 + 1, headerEnd: 1 }));
  assert.equal(looksLikeOtherRoot(p, matchPlan(p, [{ path: 'main.tf', blocks: blocks(4) }]).orphans), false);
  assert.equal(looksLikeOtherRoot(p, matchPlan(p, [{ path: 'main.tf', blocks: blocks(1) }]).orphans), true);
  assert.equal(looksLikeOtherRoot(p, matchPlan(p, [{ path: 'main.tf', blocks: blocks(3) }]).orphans), false);
});

test('hints for an import replaced right away and a moved object (real plan)', () => {
  const { hoverMarkdown } = require('../../out-test/model/hoverMarkdown.js');
  const { scanBlocks } = require('../../out-test/model/hclScanner.js');
  const rich = parsePlan(JSON.parse(readFileSync(new URL('../fixtures/rich-plan.json', import.meta.url), 'utf8')), { env: 'QUAL', source: 'run', loadedAt: 0 });
  const text = [
    'resource "local_file" "conf" {', '}',
    'resource "terraform_data" "new_name" { input = "kept" }',
    'resource "random_string" "imp" {', '}',
  ].join('\n');
  const marks = matchPlan(rich, [{ path: 'main.tf', blocks: scanBlocks(text) }]).byFile.get('main.tf');
  const hint = (name) => marks.find((m) => m.block.name === name).hint;
  assert.equal(hint('new_name'), 'moved from terraform_data.old_name');
  assert.match(hint('imp'), /^import, then replace — forced by /);
  const conf = marks.find((m) => m.block.name === 'conf');
  assert.match(hoverMarkdown(conf, rich.drift), /\*\*Changed outside Terraform\*\* · `local_file\.conf` · deleted/);
  assert.match(hoverMarkdown(marks.find((m) => m.block.name === 'imp'), rich.drift), /Imported from id `abc` — .*then replaced/);
});
