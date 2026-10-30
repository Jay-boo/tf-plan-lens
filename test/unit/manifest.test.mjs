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

test('terraform only runs in trusted workspaces; the binary setting is restricted there', () => {
  assert.equal(pkg.capabilities.untrustedWorkspaces.supported, 'limited');
  assert.ok(pkg.capabilities.untrustedWorkspaces.restrictedConfigurations.includes('planLens.terraformPath'));
  assert.equal(pkg.capabilities.virtualWorkspaces.supported, false);
  const runner = readFileSync(new URL('../../src/runner.ts', import.meta.url), 'utf8');
  assert.match(runner, /if \(!vscode\.workspace\.isTrusted\)/);
});

test('the settings page list matches package.json (keys, types, defaults)', async () => {
  const { createRequire } = await import('node:module');
  const { SETTINGS, validSetting } = createRequire(import.meta.url)('../../out-test/model/settings.js');
  const props = pkg.contributes.configuration.properties;
  for (const s of SETTINGS) {
    const p = props[`planLens.${s.key}`];
    assert.ok(p, `planLens.${s.key} missing from package.json`);
    assert.equal(p.default, s.default, `default of planLens.${s.key}`);
    assert.equal(p.type, ['visibility', 'choice', 'colors'].includes(s.type) ? 'string' : s.type, `type of planLens.${s.key}`);
    if (s.type === 'choice') assert.deepEqual(p.enum, s.options.map((o) => o.value), `options of planLens.${s.key}`);
    if (s.type === 'visibility') assert.deepEqual(p.enum, ['shown', 'discreet', 'hidden']);
  }
  assert.equal(props['planLens.sidebar.drift'].default, 'discreet');
  assert.equal(validSetting('sidebar.drift', 'hidden').value, 'hidden');
  assert.equal(validSetting('sidebar.drift', 'bogus'), undefined);
  assert.equal(validSetting('allowApply', 'true'), undefined);
  assert.equal(validSetting('environmentGlob', '**'), undefined);
  assert.equal(validSetting('terraformPath', 'a\nb'), undefined);
});

test('appearance: presets, custom colours, the look the sidebar gets', async () => {
  const { createRequire } = await import('node:module');
  const { styleOf, parseColors, validSetting } = createRequire(import.meta.url)('../../out-test/model/settings.js');
  const get = (o) => (k) => o[k];
  assert.deepEqual(styleOf(get({})), { colors: ['#8b5cf6', '#3b82f6', '#06b6d4'], radius: 3, density: 'comfortable', motion: 'subtle' });
  assert.equal(styleOf(get({ 'style.accent': 'mono' })).colors, undefined);
  assert.deepEqual(styleOf(get({ 'style.accent': 'custom', 'style.customColors': '#ff0000, #00ff00' })).colors, ['#ff0000', '#00ff00', '#ff0000']);
  assert.deepEqual(styleOf(get({ 'style.accent': 'custom', 'style.customColors': 'red' })).colors, ['#8b5cf6', '#3b82f6', '#06b6d4']);
  assert.equal(styleOf(get({ 'style.corners': 'round' })).radius, 10);
  assert.equal(parseColors('#abcdef,#123456,#000000,#ffffff'), undefined);
  assert.equal(validSetting('style.accent', 'neon'), undefined);
  assert.equal(validSetting('style.customColors', ' #AbCdEf ,#123456 ').value, '#AbCdEf, #123456');
});
