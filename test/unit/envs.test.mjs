import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { envsFromFiles, findRoot, planArgs, dataDir, isAzureAuthError, lastErrorLine } = require('../../out-test/model/envs.js');

const root = '/x/Infra%20-%20Terraform - Data';

test('discovers envs with %20 path', () => {
  const files = [`${root}/environments/QUAL/terraform.tfvars`, `${root}/environments/PROD/dev/terraform.tfvars`];
  const envs = envsFromFiles(root, files, (p) => p === `${root}/environments/QUAL/backend.conf`);
  assert.deepEqual(envs.map((e) => e.name), ['PROD/dev', 'QUAL']);
  const qual = envs[1];
  assert.equal(qual.dir, `${root}/environments/QUAL`);
  assert.equal(qual.tfvars, `${root}/environments/QUAL/terraform.tfvars`);
  assert.equal(qual.backendConf, `${root}/environments/QUAL/backend.conf`);
  assert.equal(envs[0].backendConf, undefined);
});

test('env outside environments/ is named from the root', () => {
  const envs = envsFromFiles(root, [`${root}/vars/dev/terraform.tfvars`], () => false);
  assert.equal(envs[0].name, 'vars/dev');
});

test('findRoot', () => {
  assert.equal(findRoot(`${root}/environments/PROD/dev/terraform.tfvars`), root);
  assert.equal(findRoot(`${root}/terraform.tfvars`), root);
});

test('planArgs', () => {
  const env = { name: 'QUAL', dir: `${root}/environments/QUAL`, tfvars: `${root}/environments/QUAL/terraform.tfvars`, backendConf: `${root}/environments/QUAL/backend.conf` };
  const a = planArgs(env, '/tmp/p/plan.bin');
  assert.deepEqual(a.init, ['init', '-input=false', '-reconfigure', `-backend-config=${env.backendConf}`]);
  assert.deepEqual(a.plan, ['plan', '-input=false', `-var-file=${env.tfvars}`, '-out=/tmp/p/plan.bin']);
  assert.deepEqual(a.show, ['show', '-json', '/tmp/p/plan.bin']);
  assert.deepEqual(planArgs({ ...env, backendConf: undefined }, 'o').init, ['init', '-input=false', '-reconfigure']);
  for (const arg of [...a.init, ...a.plan, ...a.show]) assert.ok(!['apply', 'destroy', 'import', 'state'].includes(arg));
});

test('dataDir', () => {
  const d = dataDir('/g', root, 'PROD/dev');
  assert.match(d, /^\/g\/[0-9a-f]{12}\/PROD_dev$/);
  assert.equal(dataDir('/g', root, 'QUAL').split('/')[2], d.split('/')[2]);
});

test('isAzureAuthError', () => {
  assert.equal(isAzureAuthError("Error: building account: please run 'az login' to setup account"), true);
  assert.equal(isAzureAuthError("Please run 'az login'"), true);
  assert.equal(isAzureAuthError('AADSTS700082: The refresh token has expired'), true);
  assert.equal(isAzureAuthError('Error: Invalid reference'), false);
});

test('lastErrorLine', () => {
  assert.equal(lastErrorLine('\x1b[31m╷\x1b[0m\n\x1b[31m│\x1b[0m \x1b[1m\x1b[31mError: \x1b[0mInvalid reference\n│ on main.tf line 3\n'), 'Error: Invalid reference');
  assert.equal(lastErrorLine('something\nfailed badly\n\n'), 'failed badly');
});
