import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePlan } = require('../../out-test/model/planParser.js');
const { findMoves, movedHcl, movedFroms } = require('../../out-test/model/refactor.js');

// A real terraform 1.14 plan (terraform_data): lake moved into module.storage, subnet count → for_each,
// module.old renamed module.new, module.inst count → for_each, gone/fresh unrelated.
const json = JSON.parse(readFileSync(new URL('../fixtures/refactor-plan.json', import.meta.url), 'utf8'));
const plan = parsePlan(json, { env: 'QUAL', source: 'run', loadedAt: 0 });
const meta = { env: 'QUAL', source: 'run', loadedAt: 0 };

/** A Change as the parser makes it, from an address like `module.a.null_resource.x`. */
const change = (address, action, values) => {
  const [, mod, type, name] = /^((?:module\.[^.[]+(?:\[[^\]]*\])?\.)*)([^.]+)\.([^.[]+)/.exec(address);
  return { address, moduleAddress: mod.replace(/\.$/, ''), modulePath: [], mode: 'managed', type, name, action, attrs: [], replaceBy: [], values };
};
const fake = (changes) => ({ ...meta, terraformVersion: '1.14.7', changes, moduleDirs: {} });

test('pairs every refactor in the real plan, and leaves the unrelated destroy/create alone', () => {
  const moves = findMoves(plan);
  const pairs = moves.map((m) => `${m.from} -> ${m.to}`).sort();
  assert.deepEqual(pairs, [
    'module.inst[0] -> module.inst["i0"]',
    'module.inst[1] -> module.inst["i1"]',
    'module.old -> module.new',
    'terraform_data.lake -> module.storage.terraform_data.this',
    'terraform_data.subnet[0] -> terraform_data.subnet["app"]',
    'terraform_data.subnet[1] -> terraform_data.subnet["db"]',
    'terraform_data.subnet[2] -> terraform_data.subnet["pe"]',
  ]);
  assert.ok(moves.every((m) => !m.ambiguous && m.score >= 0.99));
  const old = moves.find((m) => m.from === 'module.old');
  assert.equal(old.type, 'module');
  assert.deepEqual(old.covers.map((c) => c.from).sort(), ['module.old.terraform_data.tag', 'module.old.terraform_data.this']);
  // 10 of the 11 destroys explained; gone stays a destroy, fresh a create.
  assert.equal(moves.reduce((n, m) => n + m.covers.length, 0), 10);
  assert.ok(!moves.some((m) => m.covers.some((c) => c.from === 'terraform_data.gone' || c.to === 'terraform_data.fresh')));
});

test('a value every object of the type shares does not make a match', () => {
  const plan = fake([
    change('azurerm_x.a', 'destroy', { location: '"westeurope"', name: '"a"' }),
    change('azurerm_x.b', 'destroy', { location: '"westeurope"', name: '"b"' }),
    change('azurerm_x.c', 'create', { location: '"westeurope"', name: '"zzz"' }),
  ]);
  assert.deepEqual(findMoves(plan), []);
});

test('two equally good candidates: paired but ambiguous', () => {
  const plan = fake([
    change('azurerm_x.a', 'destroy', { name: '"n"', sku: '"S"' }),
    change('azurerm_x.other', 'destroy', { name: '"o"', sku: '"S"' }),
    change('azurerm_x.b', 'create', { name: '"n"', sku: '"S"' }),
    change('azurerm_x.c', 'create', { name: '"n"', sku: '"S"' }),
  ]);
  const [m, ...rest] = findMoves(plan);
  assert.equal(m.from, 'azurerm_x.a');
  assert.equal(m.ambiguous, true);
  assert.deepEqual(rest, []);
});

test('objects with nothing telling them apart never pair', () => {
  const plan = fake([
    change('random_id.a', 'destroy', { byte_length: '8' }),
    change('random_id.b', 'create', { byte_length: '8' }),
    change('random_id.c', 'create', { byte_length: '8' }),
  ]);
  assert.deepEqual(findMoves(plan), []);
});

test('only the same type pairs; a create without known values never pairs', () => {
  const plan = fake([
    change('azurerm_virtual_machine.vm', 'destroy', { name: '"vm1"' }),
    change('azurerm_linux_virtual_machine.vm', 'create', { name: '"vm1"' }),
    change('aws_s3_bucket.a', 'destroy', { bucket: '"x"' }),
    change('aws_s3_bucket.b', 'create', {}),
  ]);
  assert.deepEqual(findMoves(plan), []);
});

test('a module is not folded when some of its destroys do not pair', () => {
  const plan = fake([
    change('module.a.null_resource.x', 'destroy', { triggers: '"1"' }),
    change('module.a.null_resource.y', 'destroy', { triggers: '"2"' }),
    change('module.b.null_resource.x', 'create', { triggers: '"1"' }),
  ]);
  const moves = findMoves(plan);
  assert.deepEqual(moves.map((m) => [m.from, m.to, m.type]), [['module.a.null_resource.x', 'module.b.null_resource.x', 'null_resource']]);
});

test('movedHcl writes one block per move under a header', () => {
  const moves = findMoves(plan).filter((m) => m.from.startsWith('terraform_data.subnet'));
  const hcl = movedHcl(moves, 'Plan Lens · QUAL');
  assert.equal(hcl, [
    '# Plan Lens · QUAL',
    'moved {',
    '  from = terraform_data.subnet[0]',
    '  to   = terraform_data.subnet["app"]',
    '}',
    '',
    'moved {',
    '  from = terraform_data.subnet[1]',
    '  to   = terraform_data.subnet["db"]',
    '}',
    '',
    'moved {',
    '  from = terraform_data.subnet[2]',
    '  to   = terraform_data.subnet["pe"]',
    '}',
    '',
  ].join('\n'));
});

test('movedFroms reads the from of existing moved blocks', () => {
  const text = 'moved {\n  from = module.old\n  to = module.new\n}\nmoved { from = a.b["k"]\n to = a.c }\n# moved { from = x.y }\n';
  assert.deepEqual([...movedFroms(text)].sort(), ['a.b["k"]', 'module.old']);
});

test('one telling value under another name is too thin to tick: ambiguous', () => {
  const thin = findMoves(fake([
    change('random_password.db', 'destroy', { length: '16' }),
    change('random_password.api', 'create', { length: '16' }),
  ]));
  assert.equal(thin.length, 1);
  assert.equal(thin[0].ambiguous, true);
  // Same name (re-keyed, or moved into a module as is): one value is enough.
  const [rekeyed] = findMoves(fake([
    change('random_password.db[0]', 'destroy', { length: '16' }),
    change('random_password.db["main"]', 'create', { length: '16' }),
  ]));
  assert.equal(rekeyed.ambiguous, false);
});
