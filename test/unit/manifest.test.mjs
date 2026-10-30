import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('sidebar only shows in Terraform workspaces', () => {
  const view = pkg.contributes.views.planLens.find((v) => v.id === 'planLens.view');
  assert.equal(view.when, 'planLens.hasTerraform');
  assert.deepEqual(pkg.activationEvents, ['workspaceContains:**/*.tf']);
});

test('every registered command is contributed, and targeting is in the view menu', () => {
  const src = readFileSync(new URL('../../src/extension.ts', import.meta.url), 'utf8');
  const registered = [...src.matchAll(/registerCommand\('([^']+)'/g)].map((m) => m[1]);
  const contributed = pkg.contributes.commands.map((c) => c.command);
  for (const c of registered) assert.ok(contributed.includes(c), `${c} is not in contributes.commands`);
  assert.ok(registered.includes('planLens.targetPlan'));
  assert.ok(pkg.contributes.menus['view/title'].some((m) => m.command === 'planLens.targetPlan'));
});
