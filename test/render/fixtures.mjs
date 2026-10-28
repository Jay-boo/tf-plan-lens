import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePlan } = require('../../out-test/model/planParser.js');
const { toViewModel } = require('../../out-test/model/viewModel.js');

const json = JSON.parse(readFileSync(new URL('../fixtures/plan.json', import.meta.url), 'utf8'));
const plan = parsePlan(json, { env: 'QUAL', source: 'run', loadedAt: 0 });
const base = { env: 'QUAL', envs: ['DEV', 'PROD/dev', 'QUAL'], running: false, now: 12 * 60_000, rootName: 'Infra%20-%20Terraform%20-%20DataPlatformRessources' };
const locate = (c) => (c.address.includes('legacy') || c.address.includes('remote') ? undefined : { file: 'main.tf', line: 151 });

const large = {
  ...plan,
  changes: Array.from({ length: 300 }, (_, i) => ({
    ...plan.changes[i % plan.changes.length],
    address: `module.m${i}.${plan.changes[i % plan.changes.length].type}.very_long_resource_name_number_${i}["with-a-long-key-${i}"]`,
    moduleAddress: `module.m${i}["a-very-long-module-instance-key-${i}"]`,
  })),
};

export const fixtures = {
  empty: toViewModel(undefined, { ...base, locate }),
  running: toViewModel(plan, { ...base, running: true, locate }),
  ready: toViewModel(plan, { ...base, locate }),
  large: toViewModel(large, { ...base, locate }),
  error: toViewModel(undefined, { ...base, locate, error: "Error: building AzureRM Client: please run 'az login' to setup account." }),
};
