// The README demo's project: "acme-shop", an ordinary AWS backend (S3, DynamoDB, SQS, SNS, SSM, IAM) with dev and
// prod environments, applied for real on a fresh LocalStack so every plan in the GIFs is terraform's own.
//   node test/demo/make-project.mjs <dir> [--envs dev,prod]
// Needs docker (localstack/localstack:3.8) and terraform. Providers come from a shared plugin cache.
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, 'project');
const dir = path.resolve(process.argv[2] ?? path.join(here, 'out/acme-shop'));
const envs = (process.argv.includes('--envs') ? process.argv[process.argv.indexOf('--envs') + 1] : 'dev,prod').split(',');
export const PLUGIN_CACHE = path.join(os.homedir(), '.cache/plan-lens-demo/plugins');

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString();

/** A fresh LocalStack: nothing left from the last scene. */
function localstack() {
  try { sh('docker', ['rm', '-f', 'plan-lens-demo']); } catch { /* not running */ }
  sh('docker', ['run', '-d', '--rm', '--name', 'plan-lens-demo', '-p', '4566:4566', '-e', 'SERVICES=s3,dynamodb,sqs,sns,ssm,iam,sts', 'localstack/localstack:3.8']);
  for (let i = 0; i < 120; i++) {
    try {
      if (/"running"|"available"/.test(sh('curl', ['-s', 'http://localhost:4566/_localstack/health']))) return;
    } catch { /* not up yet */ }
    execFileSync('sleep', ['0.5']);
  }
  throw new Error('LocalStack did not start');
}

fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.cpSync(path.join(src, 'base'), dir, { recursive: true });
fs.cpSync(path.join(src, 'environments'), path.join(dir, 'environments'), { recursive: true });
fs.cpSync(path.join(src, 'modules'), path.join(dir, 'modules'), { recursive: true });
fs.mkdirSync(PLUGIN_CACHE, { recursive: true });
localstack();
const env = { ...process.env, TF_IN_AUTOMATION: '1', TF_PLUGIN_CACHE_DIR: PLUGIN_CACHE, TF_DATA_DIR: path.join(dir, '.terraform') };
for (const e of envs) {
  sh('terraform', ['init', '-input=false', '-reconfigure', `-backend-config=environments/${e}/backend.conf`], { cwd: dir, env });
  sh('terraform', ['apply', '-auto-approve', '-input=false', `-var-file=environments/${e}/terraform.tfvars`], { cwd: dir, env });
}
// The user's own .terraform would not exist on a fresh clone; Plan Lens uses its own anyway.
fs.rmSync(path.join(dir, '.terraform'), { recursive: true, force: true });
fs.writeFileSync(path.join(dir, '.gitignore'), 'state/\n.terraform/\n');
console.log(`acme-shop ready in ${dir} (${envs.join(', ')} applied on LocalStack)`);
