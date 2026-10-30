import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { changedBlocks, blockTargets, callsOf, previewHints } = require('../../out-test/model/preview.js');
const { scanBlocks } = require('../../out-test/model/hclScanner.js');

const before = [
  'resource "azurerm_storage_account" "lake" {',
  '  location = "westeurope"',
  '  sku      = "LRS"',
  '}',
  'data "azurerm_client_config" "me" {}',
  'module "net" {',
  '  source = "./net"',
  '}',
].join('\n');

test('changedBlocks: edited and new blocks only', () => {
  const after = before.replace('"westeurope"', '"francecentral"') + '\nresource "random_id" "x" {\n  byte_length = 4\n}';
  assert.deepEqual(changedBlocks(before, after).map((b) => `${b.type ?? b.kind}.${b.name}`), ['azurerm_storage_account.lake', 'random_id.x']);
  assert.deepEqual(changedBlocks(before, before), []);
});

test('blockTargets and callsOf: root and module files', () => {
  const [lake, me, net] = scanBlocks(before);
  assert.deepEqual(blockTargets(lake, [[]]), ['azurerm_storage_account.lake']);
  assert.deepEqual(blockTargets(me, [[]]), ['data.azurerm_client_config.me']);
  assert.deepEqual(blockTargets(net, [[]]), ['module.net']);
  const dirs = { net: 'modules/net', 'app.net': 'modules/net', app: 'modules/app' };
  assert.deepEqual(callsOf('modules/net', dirs), [['net'], ['app', 'net']]);
  assert.deepEqual(blockTargets(lake, callsOf('modules/net', dirs)), ['module.net.azurerm_storage_account.lake', 'module.app.module.net.azurerm_storage_account.lake']);
  assert.deepEqual(callsOf('', dirs), [[]]);
});

const change = (action, attrs, replaceBy = []) => ({ address: 'azurerm_storage_account.lake', action, attrs, replaceBy, mode: 'managed' });
const attr = (path, before, after, forcesReplace = false) => ({ path, before, after, forcesReplace, sensitive: false, unknown: false });

test('previewHints: replace forced by an attribute, update of another, on their lines', () => {
  const text = before.replace('"westeurope"', '"francecentral"').replace('"LRS"', '"GRS"');
  const [lake] = scanBlocks(text);
  const hints = previewHints(text, lake, [change('replace', [attr('location', '"westeurope"', '"francecentral"', true), attr('sku', '"LRS"', '"GRS"')], ['location'])]);
  assert.deepEqual(hints, [
    { line: 0, text: '◆ preview: replace — forced by location', look: 'replace' },
    { line: 1, text: '⟳ forces replacement', look: 'replace' },
    { line: 2, text: '~ "LRS" → "GRS"', look: 'replace' },
  ]);
});

test('previewHints: no changes, update, several instances', () => {
  const [lake] = scanBlocks(before);
  assert.deepEqual(previewHints(before, lake, [change('noop', [])]), [{ line: 0, text: '✓ preview: no changes', look: 'noop' }]);
  assert.deepEqual(previewHints(before, lake, []), [{ line: 0, text: '✓ preview: no changes', look: 'noop' }]);
  const two = previewHints(before, lake, [change('update', [attr('sku', '"LRS"', '"GRS"')]), change('noop', [])]);
  assert.deepEqual(two.map((h) => h.text), ['◆ preview: update (1 of 2 instances)', '~ "LRS" → "GRS"']);
});
