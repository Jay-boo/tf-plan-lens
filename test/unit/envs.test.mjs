import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { envsFromFiles, findRoot, planArgs, applyArgs, rootForEnvFolder, dataDir, isAzureAuthError, lastErrorLine, stateLock, unlockArgs } = require('../../out-test/model/envs.js');

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
  assert.deepEqual(planArgs(env, 'o', ['random_id.a', 'module.fn']).plan, ['plan', '-input=false', `-var-file=${env.tfvars}`, '-out=o', '-target=random_id.a', '-target=module.fn']);
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

test('stateLock reads the lock info', () => {
  const out = [
    '\x1b[31m╷\x1b[0m',
    '\x1b[31m│\x1b[0m \x1b[1m\x1b[31mError: \x1b[0m\x1b[1mError acquiring the state lock\x1b[0m',
    '│ ',
    '│ Error message: state blob is already locked',
    '│ Lock Info:',
    '│   ID:        6d2a3f1c-0b7e-4c1a-9d55-7f3b2a1e9c40',
    '│   Path:      tfstate/qual.terraform.tfstate',
    '│   Operation: OperationTypePlan',
    '│   Who:       jayboo@LAPTOP-42',
    '│   Version:   1.9.5',
    '│   Created:   2026-10-30 08:12:45.123 +0000 UTC',
    '│   Info:      ',
    '╵',
  ].join('\n');
  assert.deepEqual(stateLock(out), {
    id: '6d2a3f1c-0b7e-4c1a-9d55-7f3b2a1e9c40', who: 'jayboo@LAPTOP-42', operation: 'Plan', created: '2026-10-30 08:12:45.123 +0000 UTC',
  });
  assert.equal(stateLock('Error: Invalid reference\n  ID: x'), undefined);
  assert.deepEqual(unlockArgs('abc'), ['force-unlock', '-force', 'abc']);
});

test('environments folder: subfolders and loose tfvars files', () => {
  const base = `${root}/envs`;
  const files = [`${base}/QUAL/terraform.tfvars`, `${base}/prod.tfvars`, `${base}/dev/extra.tfvars`, `${base}/common.auto.tfvars`];
  const envs = envsFromFiles(root, files, (p) => p === `${base}/prod.backend.conf` || p === `${base}/backend.conf`, base);
  assert.deepEqual(envs.map((e) => e.name), ['dev/extra', 'prod', 'QUAL']);
  assert.equal(envs.find((e) => e.name === 'prod').backendConf, `${base}/prod.backend.conf`);
  assert.equal(envs.find((e) => e.name === 'QUAL').backendConf, undefined);
});

test('rootForEnvFolder', () => {
  assert.equal(rootForEnvFolder(`${root}/environments`, () => false), root);
  assert.equal(rootForEnvFolder(root, () => true), root);
});

test('applyArgs applies the saved plan only', () => {
  assert.deepEqual(applyArgs('/tmp/p/plan.bin'), ['apply', '-input=false', '/tmp/p/plan.bin']);
});
