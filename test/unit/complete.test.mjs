import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { completionSpot, walk, eachValues, keysOf } = require('../../out-test/model/complete.js');

test('completionSpot: locals, vars, each.value; nested paths; the part already typed', () => {
  assert.deepEqual(completionSpot('  name = local.subnets.'), { root: 'local.subnets', path: [], trigger: '.', typed: '' });
  assert.deepEqual(completionSpot('  x = local.subnets.ap'), { root: 'local.subnets', path: [], trigger: '.', typed: 'ap' });
  assert.deepEqual(completionSpot('cidr = local.subnets["app"].'), { root: 'local.subnets', path: ['app'], trigger: '.', typed: '' });
  assert.deepEqual(completionSpot('cidr = local.subnets["a'), { root: 'local.subnets', path: [], trigger: '["', typed: 'a' });
  assert.deepEqual(completionSpot('v = var.rules[0].'), { root: 'var.rules', path: [0], trigger: '.', typed: '' });
  assert.deepEqual(completionSpot('  name = each.value.'), { root: 'each.value', path: [], trigger: '.', typed: '' });
  assert.deepEqual(completionSpot('  n = "${each.value.na'), { root: 'each.value', path: [], trigger: '.', typed: 'na' });
  assert.equal(completionSpot('  name = each.key'), undefined);
  assert.equal(completionSpot('  name = local.subnets'), undefined);
  assert.equal(completionSpot('  data.azurerm_x.y.'), undefined);
});

test('walk, eachValues, keysOf: object attributes in order, merged across instances, list indexes', () => {
  const subnets = { app: { name: 'app', cidr: '10.0.0.0/24' }, db: { name: 'db', cidr: '10.0.1.0/24', private: true } };
  assert.deepEqual(walk(subnets, ['app', 'cidr']), '10.0.0.0/24');
  assert.equal(walk(subnets, ['nope', 'x']), undefined);
  assert.deepEqual(keysOf([subnets]).map((k) => `${k.key}=${k.detail}`), ['app={ name = "app", cidr = "10.0.0.0/24" }', 'db={ name = "db", cidr = "10.0.1.0/24", pr…'], 'details are cut at 40 characters');
  assert.deepEqual(keysOf(eachValues(subnets)).map((k) => k.key), ['name', 'cidr', 'private']);
  assert.deepEqual(eachValues(['a', 'b']), ['a', 'b']);
  assert.deepEqual(keysOf([['x', 'y']]).map((k) => k.key), ['0', '1']);
  assert.deepEqual(keysOf(['plain string']), []);
});
