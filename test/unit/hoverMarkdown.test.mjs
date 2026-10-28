import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePlan } = require('../../out-test/model/planParser.js');
const { matchPlan } = require('../../out-test/model/matcher.js');
const { hoverMarkdown } = require('../../out-test/model/hoverMarkdown.js');

const plan = parsePlan(JSON.parse(readFileSync(new URL('../fixtures/plan.json', import.meta.url), 'utf8')), { env: 'QUAL', source: 'run', loadedAt: 1 });
const blk = (type, name, kind = 'resource') => ({ kind, type, name, startLine: 0, endLine: 3, headerEnd: 10 });
const markFor = (path, block, p = plan) => matchPlan(p, [{ path, blocks: [block] }]).byFile.get(path)[0];

const sa = hoverMarkdown(markFor('modules/storage_account/main.tf', blk('azurerm_storage_account', 'this')));

test('replace header', () => {
  assert.ok(sa.includes('$(sync)'));
  assert.ok(sa.includes('**Replace**'));
  assert.ok(sa.includes('destroy, then create'));
  assert.ok(sa.includes('`module.storage.azurerm_storage_account.this`'));
});

test('diff row', () => {
  const row = sa.split('\n').find((l) => l.includes('location'));
  assert.ok(row.includes('<del>'));
  assert.ok(row.includes('&quot;westeurope&quot;') || row.includes('"westeurope"'));
  assert.ok(row.includes('→'));
  assert.ok(row.includes('francecentral'));
  assert.ok(row.includes('forces replace'));
  assert.ok(sa.includes('<span style="color:var(--vscode-planLens-destroy);">'));
  assert.ok(sa.includes('<span style="color:var(--vscode-planLens-create);">'));
  assert.doesNotMatch(sa, /#[0-9a-f]{3,6}\b/i);
});

test('sensitive and unknown rows', () => {
  const key = sa.split('\n').find((l) => l.includes('primary\\_access\\_key') || l.includes('primary_access_key'));
  assert.ok(key.includes('(sensitive)'));
  const id = sa.split('\n').find((l) => /\|\s*`?id`?\s*\|/.test(l));
  assert.ok(id.includes('(known after apply)'));
  assert.ok(!sa.includes('SECRET-KEY-1'));
});

test('instances', () => {
  const md = hoverMarkdown(markFor('modules/lakebase/main.tf', blk('databricks_database_instance', 'this')));
  assert.ok(md.includes('["fresh"]') && md.includes('destroy'));
  assert.ok(md.includes('["main"]'));
  assert.ok(md.indexOf('["fresh"]') < md.indexOf('["main"]'), 'most severe first');
  const many = { ...plan, changes: Array.from({ length: 8 }, (_, i) => ({ ...plan.changes[2], address: `x[${i}]`, index: `k${i}` })) };
  const m2 = hoverMarkdown(markFor('modules/storage_account/main.tf', blk('azurerm_storage_container', 'this'), many));
  assert.ok(m2.includes('+ 3 more'));
});

test('footer', () => {
  const arg = encodeURIComponent(JSON.stringify(['module.storage.azurerm_storage_account.this']));
  assert.ok(sa.includes(`command:planLens.reveal?${arg}`));
  assert.ok(sa.includes(`command:planLens.copyAddress?${arg}`));
  assert.ok(sa.includes('command:planLens.openLog'));
});

test('escaping', () => {
  const evil = { ...plan, changes: [{ ...plan.changes[2], attrs: [{ path: 'a|b', before: '"<script>x</script>"', after: '"`tick` | pipe"', sensitive: false, unknown: false, forcesReplace: false }] }] };
  const md = hoverMarkdown(markFor('modules/storage_account/main.tf', blk('azurerm_storage_container', 'this'), evil));
  assert.ok(!md.includes('<script>'));
  const row = md.split('\n').find((l) => l.includes('script'));
  assert.equal(row.split(/(?<!\\)\|/).length, 5, 'row keeps 3 cells');
});
