import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { envsFromFiles, findRoot, planArgs, applyArgs, rootForEnvFolder, dataDir, cloudLogin, lastErrorLine, stateLock, unlockArgs } = require('../../out-test/model/envs.js');

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

test('cloudLogin', () => {
  const az = { cloud: 'Azure', command: 'az login' };
  assert.deepEqual(cloudLogin("Error: building account: please run 'az login' to setup account"), az);
  assert.deepEqual(cloudLogin('AADSTS700082: The refresh token has expired'), az);
  assert.equal(cloudLogin('Error: no valid credential sources for S3 Backend found.').cloud, 'AWS');
  assert.equal(cloudLogin('Error: refreshing cached SSO token failed: SSO session has expired or is invalid').command, 'aws sso login');
  assert.equal(cloudLogin('operation error STS: GetCallerIdentity, api error ExpiredToken: The security token included in the request is expired').cloud, 'AWS');
  assert.deepEqual(cloudLogin('google: could not find default credentials. See https://cloud.google.com/docs/authentication'), { cloud: 'Google Cloud', command: 'gcloud auth application-default login' });
  assert.equal(cloudLogin('oauth2: cannot fetch token: 400 Bad Request Response: {"error":"invalid_grant"}').cloud, 'Google Cloud');
  assert.equal(cloudLogin('Error: Invalid reference'), undefined);
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

test('plain root env: no -var-file; workspace through TF_WORKSPACE', () => {
  const { runEnvVars } = require('../../out-test/model/envs.js');
  const env = { name: 'infra:prod', root: '/w/infra', dir: '/w/infra', workspace: 'prod' };
  assert.deepEqual(planArgs(env, 'o').plan, ['plan', '-input=false', '-out=o']);
  assert.deepEqual(runEnvVars(env), { TF_WORKSPACE: 'prod' });
  assert.deepEqual(runEnvVars({ ...env, workspace: undefined }), {});
  assert.match(dataDir('/g', '/w/infra', 'infra:prod'), /\/infra_prod$/);
});

test('envsFromFiles sets the root', () => {
  assert.equal(envsFromFiles(root, [`${root}/environments/QUAL/terraform.tfvars`], () => false)[0].root, root);
});

test('pickBinary: the setting, else terraform, else tofu when only it is there', () => {
  const { pickBinary } = require('../../out-test/model/envs.js');
  assert.equal(pickBinary('/opt/tf', () => false), '/opt/tf');
  assert.equal(pickBinary(undefined, (n) => n === 'terraform' || n === 'tofu'), 'terraform');
  assert.equal(pickBinary(undefined, (n) => n === 'tofu'), 'tofu');
  assert.equal(pickBinary(undefined, () => false), 'terraform');
});

test('previewArgs: read only — no refresh, no lock, targets', () => {
  const { previewArgs } = require('../../out-test/model/envs.js');
  const env = { name: 'QUAL', root: '/r', dir: '/r', tfvars: '/r/q.tfvars' };
  assert.deepEqual(previewArgs(env, 'o', ['a.b']), ['plan', '-input=false', '-refresh=false', '-lock=false', '-var-file=/r/q.tfvars', '-out=o', '-target=a.b']);
});

test('movedTargets reads the -target options terraform asks for (real terraform 1.14 message)', () => {
  const { movedTargets } = require('../../out-test/model/envs.js');
  const text = [
    '│ Error: Moved resource instances excluded by targeting',
    '│ ',
    '│ Resource instances in your current state have moved to new addresses in the latest configuration. Terraform must include those resource instances while planning in order to ensure a correct result, but your -target=... options do not fully cover all of those resource instances.',
    '│ ',
    '│ To create a valid plan, either remove your -target=... options altogether or add the following additional target options:',
    '│   -target="module.inst[\\"i0\\"]"',
    '│   -target="terraform_data.lake"',
  ].join('\n');
  assert.deepEqual(movedTargets(text), ['module.inst["i0"]', 'terraform_data.lake']);
  assert.deepEqual(movedTargets('Error: something else -target="x"'), []);
});
