// End to end: a throwaway VS Code with Plan Lens on a real refactored Terraform root (terraform_data only, no
// provider download), driven by test/e2e/suite.js. Needs terraform on the PATH.
//   node test/e2e/runTest.js [--vscode /path/to/code]
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// @vscode/test-electron and its VS Code download are borrowed from dataframe-lens when not installed here.
const sibling = path.resolve(__dirname, '../../../dataframe-lens');
let runTests;
try {
  ({ runTests } = require('@vscode/test-electron'));
} catch {
  ({ runTests } = require(path.join(sibling, 'node_modules/@vscode/test-electron')));
}

// Set when launched from a VS Code terminal; it would make the test VS Code start as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const root = path.resolve(__dirname, '../..');
const scenario = path.join(__dirname, 'scenario');
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-lens-e2e-'));
fs.cpSync(path.join(scenario, 'modules'), path.join(ws, 'modules'), { recursive: true });
// State of v1 applied, then the code refactored to v2: the plan destroys and recreates everything that moved.
const tf = (...args) => execFileSync('terraform', args, { cwd: ws, stdio: 'pipe', env: { ...process.env, TF_IN_AUTOMATION: '1' } });
fs.copyFileSync(path.join(scenario, 'v1/main.tf'), path.join(ws, 'main.tf'));
tf('init', '-input=false');
tf('apply', '-auto-approve', '-input=false');
fs.copyFileSync(path.join(scenario, 'v2/main.tf'), path.join(ws, 'main.tf'));
fs.rmSync(path.join(ws, '.terraform'), { recursive: true, force: true });
fs.rmSync(path.join(ws, '.terraform.lock.hcl'), { force: true });

const i = process.argv.indexOf('--vscode');
const local = path.join(sibling, '.vscode-test/vscode-linux-x64-1.144.0/code');
runTests({
  vscodeExecutablePath: i > 0 ? process.argv[i + 1] : fs.existsSync(local) ? local : undefined,
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(__dirname, 'suite.js'),
  launchArgs: [ws, '--disable-extensions', '--disable-workspace-trust', '--user-data-dir', path.join(os.tmpdir(), 'plan-lens-e2e-user')],
  extensionTestsEnv: { PLAN_LENS_E2E: ws },
})
  .then(() => {
    // Terraform's own verdict on what Plan Lens wrote: only the unrelated destroy is left.
    tf('init', '-input=false');
    const out = tf('plan', '-input=false', '-no-color').toString();
    const destroys = (out.match(/will be destroyed/g) || []).length;
    console.log(`  terraform plan after moved.tf: ${out.match(/Plan: .*/)?.[0]}`);
    if (destroys !== 1) throw new Error(`expected 1 destroy left, got ${destroys}`);
    console.log('  ✔ terraform agrees: 1 destroy left (the unrelated one)');
  })
  .then(() => {
    // A root calling a module outside its folder, like `source = "../../modules/vm"`.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-lens-e2e-outside-'));
    fs.mkdirSync(path.join(outside, 'stacks/app'), { recursive: true });
    fs.mkdirSync(path.join(outside, 'modules/box'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'modules/box/main.tf'), 'variable "name" {}\nresource "terraform_data" "this" { input = var.name }\n');
    fs.writeFileSync(path.join(outside, 'stacks/app/main.tf'), 'module "box" {\n  source = "../../modules/box"\n  name   = "alpha"\n}\n');
    return runTests({
      vscodeExecutablePath: i > 0 ? process.argv[i + 1] : fs.existsSync(local) ? local : undefined,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'outside-suite.js'),
      launchArgs: [outside, '--disable-extensions', '--disable-workspace-trust', '--user-data-dir', path.join(os.tmpdir(), 'plan-lens-e2e-user-outside')],
      extensionTestsEnv: { PLAN_LENS_E2E: outside },
    });
  })
  .catch((e) => {
    console.error('Tests failed', e);
    process.exit(1);
  });
