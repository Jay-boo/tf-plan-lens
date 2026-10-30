// Runs inside the VS Code extension host on a root that calls a module outside its folder (stacks/app →
// ../../modules/box): planning the root marks the module's own file.
const assert = require('assert');
const path = require('path');
const vscode = require('vscode');

const until = async (what, fn, ms = 180000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what}`);
};

exports.run = async function () {
  const ws = process.env.PLAN_LENS_E2E;
  const mod = vscode.Uri.file(path.join(ws, 'modules/box/main.tf'));
  await vscode.extensions.getExtension('jay-boo.tf-plan-lens').activate();
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mod));
  // The only root is stacks/app (modules/ is never one): Run plan needs no picker.
  await vscode.commands.executeCommand('planLens.runPlan');
  const hover = async () => {
    const hs = await vscode.commands.executeCommand('vscode.executeHoverProvider', mod, new vscode.Position(1, 3));
    return (hs || []).flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
  };
  await until('the plan on the module file', async () => /\*\*Create\*\*/.test(await hover()));
  assert.match(await hover(), /module\.box\.terraform_data\.this/);
  console.log('  ✔ a module outside the root (../../modules/box) shows the plan on its own file');
};
