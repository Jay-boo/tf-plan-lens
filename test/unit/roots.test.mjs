import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { terraformRoots, localModuleDirs, rootEnvs, parseWorkspaceList, qualifyNames } = require('../../out-test/model/roots.js');

const w = '/w';

test('localModuleDirs resolves ./ and ../ sources only', () => {
  const text = [
    'module "a" {',
    '  source = "./modules/a/"',
    '}',
    'module "b" { source = "../shared/b" }',
    'module "c" {',
    '  source  = "Azure/naming/azurerm"',
    '}',
    'terraform {',
    '  required_providers { azurerm = { source = "hashicorp/azurerm" } }',
    '}',
  ].join('\n');
  assert.deepEqual(localModuleDirs(`${w}/infra`, text), [`${w}/infra/modules/a`, `${w}/shared/b`]);
});

test('terraformRoots: folders with .tf, minus local modules and modules/ folders', () => {
  const roots = terraformRoots([
    { path: `${w}/infra/main.tf`, text: 'module "fn" { source = "../components/fn" }' },
    { path: `${w}/infra/vars.tf`, text: '' },
    { path: `${w}/components/fn/main.tf`, text: 'resource "x" "y" {}' },
    { path: `${w}/modules/net/main.tf`, text: '' },
    { path: `${w}/infra/modules/db/main.tf`, text: '' },
    { path: `${w}/landing_zone/main.tf`, text: '' },
    { path: `${w}/main.tf`, text: '' },
  ]);
  assert.deepEqual(roots, [w, `${w}/infra`, `${w}/landing_zone`]);
});

test('rootEnvs: one plain env, plus one per workspace other than default', () => {
  assert.deepEqual(rootEnvs(`${w}/infra`, 'infra', []), [{ name: 'infra', root: `${w}/infra`, dir: `${w}/infra` }]);
  const envs = rootEnvs(`${w}/infra`, 'infra', ['default', 'staging', 'prod']);
  assert.deepEqual(envs.map((e) => e.name), ['infra', 'infra:prod', 'infra:staging']);
  assert.equal(envs[1].workspace, 'prod');
  assert.equal(envs[0].workspace, undefined);
  assert.equal(envs[0].tfvars, undefined);
});

test('parseWorkspaceList', () => {
  assert.deepEqual(parseWorkspaceList('  default\n* staging\n  prod\n\n'), ['default', 'staging', 'prod']);
  assert.deepEqual(parseWorkspaceList(''), []);
});

test('qualifyNames prefixes env names with their root only when several roots have envs', () => {
  const one = [{ name: 'QUAL', root: `${w}/a`, dir: '' }, { name: 'PROD', root: `${w}/a`, dir: '' }];
  assert.deepEqual(qualifyNames(one, (r) => r.slice(3)).map((e) => e.name), ['QUAL', 'PROD']);
  const two = [...one, { name: 'QUAL', root: `${w}/b`, dir: '' }];
  assert.deepEqual(qualifyNames(two, (r) => r.slice(3)).map((e) => e.name), ['a/QUAL', 'a/PROD', 'b/QUAL']);
});
