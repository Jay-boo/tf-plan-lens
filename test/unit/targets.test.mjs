import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { covers, compactTargets, targetArgs } = require('../../out-test/model/targets.js');

test('covers: exact, instance keys and module prefixes only', () => {
  assert.ok(covers('azurerm_storage_account.sa', 'azurerm_storage_account.sa'));
  assert.ok(covers('azurerm_storage_account.sa', 'azurerm_storage_account.sa["eu"]'));
  assert.ok(covers('azurerm_storage_account.sa', 'azurerm_storage_account.sa[0]'));
  assert.ok(covers('module.fn', 'module.fn.azurerm_linux_function_app.app'));
  assert.ok(covers('module.fn', 'module.fn["a"].azurerm_linux_function_app.app'));
  assert.ok(covers('module.fn', 'module.fn.module.inner.random_id.x'));
  assert.ok(!covers('module.fn', 'module.fn2.random_id.x'));
  assert.ok(!covers('azurerm_storage_account.sa', 'azurerm_storage_account.sa2'));
  assert.ok(!covers('module.fn.random_id.x', 'module.fn'));
});

test('compactTargets drops what another target covers, keeps order, dedupes', () => {
  assert.deepEqual(compactTargets(['module.fn.random_id.x', 'random_id.a', 'module.fn', 'random_id.a']), ['random_id.a', 'module.fn']);
  assert.deepEqual(compactTargets([]), []);
});

test('targetArgs: one -target per address, refuses flag-looking input', () => {
  assert.deepEqual(targetArgs(['random_id.a', 'module.fn["k"]']), ['-target=random_id.a', '-target=module.fn["k"]']);
  assert.throws(() => targetArgs(['-destroy']));
  assert.throws(() => targetArgs(['']));
});
