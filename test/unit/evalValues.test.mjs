import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evalTargets } = require('../../out-test/model/evalTargets.js');
const { batchFile, consoleQuery, parseConsole, errorsByIndex, inlineValue, prettyValue, instancesValue } = require('../../out-test/model/evalBatch.js');

const tf = readFileSync(new URL('../fixtures/values.tf', import.meta.url), 'utf8');

test('evalTargets: locals, variables, for_each/count, outputs; skips nested, comments, heredocs, each.*', () => {
  const t = evalTargets(tf);
  const lines = tf.split('\n');
  const at = (x) => `${x.kind}@${lines[x.line].trim().split(' ')[0]}: ${x.expr}`;
  assert.deepEqual(t.map(at), [
    'variable@variable: var.env',
    'variable@variable: var.subnets',
    'local@rg_name: local.rg_name',
    'local@subnets: local.subnets',
    'local@script: local.script',
    'local@tags: local.tags',
    // Comments inside stay: the text goes verbatim into a .tf file, where they are valid.
    'instances@for_each: {\n    for k, v in local.subnets : k => v # trailing\n  }',
    'instances@count: length(var.subnets)',
    'instances@for_each: toset(["a"])',
    'output@value: "https://${local.rg_name}.example"',
  ]);
});

test('batchFile wraps each expression verbatim; starts point at their first line', () => {
  const { text, starts } = batchFile(['local.a', '{\n  x = 1\n}']);
  const lines = text.split('\n');
  assert.equal(lines[starts[0]], '  __pl_0 = try(jsonencode(');
  assert.equal(lines[starts[1]], '  __pl_1 = try(jsonencode(');
  assert.match(text, /    \{\n      x = 1\n    \}\n  \), "!plan-lens-err"\)/);
  assert.equal(consoleQuery([0, 2]), '{ e0 = local.__pl_0, e2 = local.__pl_2 }');
  assert.doesNotMatch(batchFile(['local.a'], true).text, /try\(/);
});

test('parseConsole: values, unknown, sensitive, caught errors, escapes (real terraform 1.14 output)', () => {
  const out = [
    '{',
    '  "e0" = "\\"rg-qual-data\\""',
    '  "e1" = "{\\"app\\":\\"10.0.0.0/24\\"}"',
    '  "e2" = (known after apply)',
    '  "e3" = (sensitive value)',
    '  "e4" = "\\"a\\\\\\"b\\\\nc qual\\""',
    '  "e5" = "\\"!plan-lens-err\\""',
    '  "e6" = "\\"$${x}\\""',
    '}',
  ].join('\n');
  const v = parseConsole(out);
  assert.deepEqual(v.get(0), { kind: 'value', value: 'rg-qual-data' });
  assert.deepEqual(v.get(1), { kind: 'value', value: { app: '10.0.0.0/24' } });
  assert.deepEqual(v.get(2), { kind: 'unknown' });
  assert.deepEqual(v.get(3), { kind: 'sensitive' });
  assert.deepEqual(v.get(4), { kind: 'value', value: 'a"b\nc qual' });
  assert.equal(v.get(5).kind, 'value'); // a string that only looks like the marker inside JSON quotes stays a value
  assert.deepEqual(v.get(6), { kind: 'value', value: '${x}' });
  assert.deepEqual(parseConsole('{\n  "e0" = "!plan-lens-err"\n}').get(0), { kind: 'error', message: '' });
});

test('errorsByIndex maps terraform errors in the generated file to expressions', () => {
  const { starts } = batchFile(['local.a', 'local.nope', 'local.b']);
  const stderr = [
    '\x1b[31m╷\x1b[0m',
    '│ \x1b[1m\x1b[31mError: \x1b[0mReference to undeclared local value',
    '│ ',
    `│   on zz_planlens_eval.tf line ${starts[1] + 2}, in locals:`,
    `│    ${starts[1] + 2}:     local.nope`,
    '│ ',
    '│ A local value with the name "nope" has not been declared.',
    '╵',
  ].join('\n');
  assert.deepEqual([...errorsByIndex(stderr, starts)], [[1, 'Reference to undeclared local value: A local value with the name "nope" has not been declared.']]);
});

test('inline and pretty HCL, instances', () => {
  assert.equal(inlineValue({ app: { cidr: '10.0.0.0/24' }, 'a-b': [1, 2] }), '{ app = { cidr = "10.0.0.0/24" }, a-b = [1, 2] }');
  assert.equal(inlineValue({ 'with space': true }), '{ "with space" = true }');
  assert.equal(inlineValue('x'.repeat(100)).length, 60);
  assert.equal(prettyValue({ app: { cidr: '10.0.0.0/24', name: 'app' }, db: null }), '{\n  app = {\n    cidr = "10.0.0.0/24"\n    name = "app"\n  }\n  db  = null\n}');
  assert.equal(instancesValue({ app: 1, db: 2 }), '2 instances: "app", "db"');
  assert.equal(instancesValue(['a']), '1 instance: "a"');
  assert.equal(instancesValue(3), '3 instances');
  assert.equal(instancesValue([]), 'no instances');
});

test('modules: outputs file, root locals through the calls, one value per instance (real terraform 1.14 output)', () => {
  const { moduleBatchFile, moduleRootFile, moduleInstances, errorsByIndex, MODULE_EVAL_FILE } = require('../../out-test/model/evalBatch.js');
  const { text, starts } = moduleBatchFile(['local.cidr', 'var.base']);
  assert.match(text, /output "__pl_0" \{\n  value = try\(jsonencode\(\n    local\.cidr\n  \), "!plan-lens-err"\)\n\}/);
  assert.equal(text.split('\n')[starts[1]], 'output "__pl_1" {');
  assert.equal(moduleRootFile(1, [{ name: 'one', multi: false }, { name: 'many', multi: true }]).text.split('\n')[2],
    '  __pl_0 = jsonencode({ one = { "" = module.one.__pl_0 }, many = { for k, m in module.many : k => m.__pl_0 } })');
  const got = parseConsole('{\n  "e0" = "{\\"many\\":{\\"app\\":\\"\\\\\\"10.1.1.0/24\\\\\\"\\",\\"db\\":\\"\\\\\\"10.2.1.0/24\\\\\\"\\"},\\"one\\":{\\"\\":\\"\\\\\\"10.0.1.0/24\\\\\\"\\"}}"\n  "e1" = (sensitive value)\n}');
  assert.deepEqual(moduleInstances(got.get(0)), [
    { label: 'module.many["app"]', value: { kind: 'value', value: '10.1.1.0/24' } },
    { label: 'module.many["db"]', value: { kind: 'value', value: '10.2.1.0/24' } },
    { label: 'module.one', value: { kind: 'value', value: '10.0.1.0/24' } },
  ]);
  assert.deepEqual(moduleInstances(got.get(1)), [{ label: '', value: { kind: 'sensitive' } }]);
  assert.deepEqual(moduleInstances({ kind: 'value', value: { c: { 0: '"x"' } } })[0].label, 'module.c[0]');
  const err = '│ Error: Reference to undeclared local value\n│ \n│   on modules/net/zz_planlens_module_eval.tf line 3, in output "__pl_0":\n│    3:     local.nope\n│ \n│ A local value with the name "nope" has not been declared.\n';
  assert.equal(errorsByIndex(err, starts, MODULE_EVAL_FILE).get(0), 'Reference to undeclared local value: A local value with the name "nope" has not been declared.');
  assert.equal(errorsByIndex(err, starts).size, 0);
});

test('moduleCallsOf: the root calls of a module folder, multi with for_each / count', () => {
  const { moduleCallsOf } = require('../../out-test/model/roots.js');
  const root = '/r';
  const files = [
    { path: '/r/main.tf', text: 'module "lakebase" {\n  source = "./modules/lakebase"\n}\nmodule "lakebase_spn" {\n  source   = "./modules/lakebase/"\n  for_each = toset(["a"])\n}\nmodule "other" {\n  source = "./modules/x"\n}' },
    { path: '/r/modules/lakebase/main.tf', text: 'module "inner" {\n  source = "../lakebase"\n}' },
  ];
  assert.deepEqual(moduleCallsOf(root, files, '/r/modules/lakebase'), [{ name: 'lakebase', multi: false }, { name: 'lakebase_spn', multi: true }]);
  assert.deepEqual(moduleCallsOf(root, files, '/r/modules/none'), []);
});
