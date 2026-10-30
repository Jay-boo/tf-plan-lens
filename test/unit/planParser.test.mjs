import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePlan } = require('../../out-test/model/planParser.js');

const json = JSON.parse(readFileSync(new URL('../fixtures/plan.json', import.meta.url), 'utf8'));
const plan = parsePlan(json, { env: 'QUAL', source: 'run', loadedAt: 1 });
const by = (address) => plan.changes.find((c) => c.address === address);

test('actions map', () => {
  assert.equal(by('databricks_catalog.diapason_fresh').action, 'create');
  assert.equal(by('module.storage.azurerm_storage_container.this["raw"]').action, 'update');
  assert.equal(by('module.storage.azurerm_storage_account.this').action, 'replace');
  assert.equal(by('module.storage.azurerm_storage_management_policy.this').action, 'replace');
  assert.equal(by('module.unitycatalog.databricks_schema.legacy').action, 'destroy');
  assert.equal(by('azurerm_role_assignment.old').action, 'forget');
  assert.equal(by('data.azurerm_client_config.current').action, 'read');
  assert.equal(by('module.storage.azurerm_storage_container.this["gold"]').action, 'noop');
  assert.equal(plan.terraformVersion, '1.14.7');
  assert.equal(plan.env, 'QUAL');
});

test('replace forced by', () => {
  const c = by('module.storage.azurerm_storage_account.this');
  assert.deepEqual(c.replaceBy, ['location']);
  const loc = c.attrs.find((a) => a.path === 'location');
  assert.equal(loc.forcesReplace, true);
  assert.equal(loc.before, '"westeurope"');
  assert.equal(loc.after, '"francecentral"');
  assert.equal(c.reason, 'replace_because_cannot_update');
  assert.deepEqual(by('module.storage.azurerm_storage_management_policy.this').replaceBy, ['rule[0].name']);
});

test('unknown and sensitive', () => {
  const c = by('module.storage.azurerm_storage_account.this');
  const id = c.attrs.find((a) => a.path === 'id');
  assert.equal(id.unknown, true);
  assert.equal(id.after, '');
  const key = c.attrs.find((a) => a.path === 'primary_access_key');
  assert.equal(key.sensitive, true);
  assert.equal(key.before, '');
  assert.equal(key.after, '');
  assert.ok(!JSON.stringify(c).includes('SECRET-KEY-1'));
});

test('whole-object sensitive', () => {
  const c = by('module.kv.azurerm_key_vault_secret.s');
  assert.ok(c.attrs.length > 0);
  assert.ok(c.attrs.every((a) => a.sensitive));
  const s = JSON.stringify(c);
  assert.ok(!s.includes('OLD-SECRET-VALUE') && !s.includes('NEW-SECRET-VALUE'));
});

test('module path strips keys', () => {
  const c = by('module.lakebase["fresh"].databricks_database_instance.this');
  assert.deepEqual(c.modulePath, ['lakebase']);
  assert.equal(c.moduleAddress, 'module.lakebase["fresh"]');
  assert.deepEqual(by('module.unitycatalog.module.inner.databricks_grants.g').modulePath, ['unitycatalog', 'inner']);
  assert.equal(by('module.storage.azurerm_storage_container.this["raw"]').index, 'raw');
  assert.deepEqual(by('databricks_catalog.diapason_fresh').modulePath, []);
});

test('moduleDirs', () => {
  assert.deepEqual(plan.moduleDirs, {
    storage: 'modules/storage_account',
    lakebase: 'modules/lakebase',
    unitycatalog: 'modules/databricks_unitycatalog',
    'unitycatalog.inner': 'modules/shared',
    kv: 'modules/key_vault',
  });
});

test('long values cut', () => {
  const a = by('databricks_catalog.long').attrs.find((x) => x.path === 'comment');
  assert.ok(a.after.length <= 81);
  assert.ok(a.after.endsWith('…'));
});

test('rejects junk', () => {
  assert.throws(() => parsePlan({}, { env: '', source: '', loadedAt: 0 }), /Not a Terraform plan JSON/);
});

test('replace path covers its children', () => {
  const p = parsePlan({
    format_version: '1.2', resource_changes: [{
      address: 'terraform_data.swap', mode: 'managed', type: 'terraform_data', name: 'swap',
      change: { actions: ['delete', 'create'], before: { triggers_replace: ['one'], input_x: 'a' }, after: { triggers_replace: ['two'], input_x: 'b' },
        after_unknown: {}, before_sensitive: {}, after_sensitive: {}, replace_paths: [['triggers_replace'], ['input']] },
    }],
  }, { env: '', source: '', loadedAt: 0 });
  const attrs = Object.fromEntries(p.changes[0].attrs.map((a) => [a.path, a.forcesReplace]));
  assert.deepEqual(attrs, { 'triggers_replace[0]': true, input_x: false });
});

test('nested sensitive under an unknown parent never leaks', () => {
  const p = parsePlan({
    format_version: '1.2', resource_changes: [{
      address: 'x.y', mode: 'managed', type: 'x', name: 'y',
      change: { actions: ['update'], before: { conn: { password: 'S3CRET', host: 'h' }, tags: { a: '1' } }, after: { tags: { a: '2' } },
        after_unknown: { conn: true }, before_sensitive: { conn: { password: true } }, after_sensitive: {} },
    }],
  }, { env: '', source: '', loadedAt: 0 });
  const c = p.changes[0];
  assert.ok(!JSON.stringify(c).includes('S3CRET'));
  const conn = c.attrs.find((a) => a.path.startsWith('conn'));
  assert.equal(conn.sensitive, true);
  assert.equal(c.attrs.find((a) => a.path === 'tags.a').after, '"2"');
});

test('a real plan with drift, an import, a moved object and output changes', () => {
  const p = parsePlan(JSON.parse(readFileSync(new URL('../fixtures/rich-plan.json', import.meta.url), 'utf8')), { env: 'QUAL', source: 'run', loadedAt: 0 });
  assert.deepEqual(p.drift.map((c) => [c.address, c.action]), [['local_file.conf', 'destroy']]);
  const imp = p.changes.find((c) => c.address === 'random_string.imp');
  assert.equal(imp.importing, 'abc');
  assert.equal(imp.action, 'replace');
  assert.equal(p.changes.find((c) => c.address === 'terraform_data.new_name').previousAddress, 'terraform_data.old_name');
  assert.deepEqual(p.outputs.map((o) => [o.name, o.action, o.before, o.after, o.sensitive]), [
    ['conf_path', 'update', '"./out/conf.txt"', '"./out/conf.txt!"', false],
    ['old_output', 'destroy', '"bye"', '', false],
    ['token', 'create', '', '', true],
  ]);
});
