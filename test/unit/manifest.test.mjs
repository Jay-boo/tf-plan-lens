import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('sidebar only shows in Terraform workspaces', () => {
  const view = pkg.contributes.views.planLens.find((v) => v.id === 'planLens.view');
  assert.equal(view.when, 'planLens.hasTerraform');
  assert.deepEqual(pkg.activationEvents, ['workspaceContains:**/*.tf']);
});
