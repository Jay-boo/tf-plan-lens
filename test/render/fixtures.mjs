import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePlan } = require('../../out-test/model/planParser.js');
const { toViewModel } = require('../../out-test/model/viewModel.js');
const { findMoves } = require('../../out-test/model/refactor.js');

const json = JSON.parse(readFileSync(new URL('../fixtures/plan.json', import.meta.url), 'utf8'));
const plan = parsePlan(json, { env: 'QUAL', source: 'run', loadedAt: 0 });
const base = { env: 'QUAL', envs: ['DEV', 'PROD/dev', 'QUAL'], running: false, now: 12 * 60_000, rootName: 'Infra%20-%20Terraform%20-%20DataPlatformRessources', envFolder: 'environments/**/terraform.tfvars' };
const tail = ['$ terraform plan -input=false -var-file=environments/QUAL/terraform.tfvars -out=/tmp/plan-lens-x/plan.bin', 'module.storage.azurerm_storage_account.lake: Refreshing state... [id=/subscriptions/0000/resourceGroups/rg-qual-data/providers/Microsoft.Storage/storageAccounts/stqualdata]', 'databricks_catalog.diapason: Refreshing state... [id=diapason]', 'databricks_schema.raw: Refreshing state... [id=diapason.raw]', 'databricks_grants.raw: Refreshing state...', 'azurerm_key_vault_secret.sp: Refreshing state...'];
const locate = (c) => (c.address.includes('legacy') || c.address.includes('remote') ? undefined : { file: 'main.tf', line: 151 });

const large = {
  ...plan,
  changes: Array.from({ length: 300 }, (_, i) => ({
    ...plan.changes[i % plan.changes.length],
    address: `module.m${i}.${plan.changes[i % plan.changes.length].type}.very_long_resource_name_number_${i}["with-a-long-key-${i}"]`,
    moduleAddress: `module.m${i}["a-very-long-module-instance-key-${i}"]`,
  })),
};

// A real refactor (terraform_data): renames, a move into a module, count → for_each; one ambiguous pair added.
const refactorPlan = parsePlan(JSON.parse(readFileSync(new URL('../fixtures/refactor-plan.json', import.meta.url), 'utf8')), { env: 'QUAL', source: 'run', loadedAt: 0 });
const refactorMoves = [...findMoves(refactorPlan), { id: 'azurerm_subnet.pe>module.network.azurerm_subnet.private_endpoints', from: 'azurerm_subnet.pe', to: 'module.network.azurerm_subnet.private_endpoints', type: 'azurerm_subnet', score: 0.86, ambiguous: true, covers: [{ from: 'azurerm_subnet.pe', to: 'module.network.azurerm_subnet.private_endpoints' }] }];

// A real plan with drift, an import replaced right away, a moved object and output changes.
const richPlan = parsePlan(JSON.parse(readFileSync(new URL('../fixtures/rich-plan.json', import.meta.url), 'utf8')), { env: 'QUAL', source: 'run', loadedAt: 0 });

export const fixtures = {
  empty: toViewModel(undefined, { ...base, locate }),
  running: toViewModel(plan, { ...base, running: true, locate, tail }),
  ready: toViewModel(plan, { ...base, locate }),
  large: toViewModel(large, { ...base, locate }),
  apply: toViewModel(plan, { ...base, locate, canApply: true }),
  applying: toViewModel(plan, { ...base, locate, running: true, applying: true, tail: tail.slice(0, 2) }),
  applyoff: toViewModel(plan, { ...base, locate, applyOff: true }),
  targeted: toViewModel({ ...plan, targets: ['module.storage', 'databricks_catalog.diapason_fresh'] }, { ...base, locate, canApply: true }),
  noenvs: toViewModel(undefined, { ...base, envs: [], env: undefined, envFolder: 'infra/envs/', locate }),
  rich: toViewModel(richPlan, { ...base, locate: () => ({ file: 'main.tf', line: 7 }) }),
  refactor: toViewModel(refactorPlan, { ...base, locate: () => undefined, moves: refactorMoves }),
  refactorLoaded: toViewModel({ ...refactorPlan, env: '', source: '/tmp/plan.json' }, { ...base, locate: () => undefined, moves: refactorMoves.slice(0, 2) }),
  error: toViewModel(undefined, { ...base, locate, error: "Error: building AzureRM Client: please run 'az login' to setup account." }),
};
