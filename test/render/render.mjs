// Renders the sidebar webview with fixture models × themes × widths; fails on horizontal overflow.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fixtures, settingsPage } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(join(homedir(), 'projects/gitland/node_modules/playwright-core'));
const root = new URL('../../', import.meta.url).pathname;

// Values of VS Code's Dark Modern / Light Modern / High Contrast for the variables the webview reads.
const themes = {
  dark: { cls: 'vscode-dark', vars: { foreground: '#cccccc', descriptionForeground: '#9d9d9d', 'editor-background': '#1f1f1f', 'sideBar-background': '#181818',
    focusBorder: '#0078d4', 'button-background': '#0078d4', 'button-foreground': '#ffffff', 'button-hoverBackground': '#026ec1', 'button-secondaryBackground': '#313131',
    'button-secondaryForeground': '#cccccc', 'list-hoverBackground': '#2a2d2e', 'textCodeBlock-background': '#2b2b2b', 'charts-blue': '#3794ff', 'charts-yellow': '#cca700',
    'charts-orange': '#d18616', 'testing-iconPassed': '#73c991', errorForeground: '#f85149',
    'planLens-create': '#73c991', 'planLens-update': '#cca700', 'planLens-replace': '#d18616', 'planLens-destroy': '#f85149', 'planLens-read': '#3794ff' } },
  light: { cls: 'vscode-light', vars: { foreground: '#3b3b3b', descriptionForeground: '#3b3b3b', 'editor-background': '#ffffff', 'sideBar-background': '#f8f8f8',
    focusBorder: '#005fb8', 'button-background': '#005fb8', 'button-foreground': '#ffffff', 'button-hoverBackground': '#0258a8', 'button-secondaryBackground': '#e5e5e5',
    'button-secondaryForeground': '#3b3b3b', 'list-hoverBackground': '#f2f2f2', 'charts-blue': '#1a85ff', 'charts-yellow': '#bf8803', 'charts-orange': '#c27d00',
    'testing-iconPassed': '#388a34', errorForeground: '#e51400',
    'planLens-create': '#388a34', 'planLens-update': '#bf8803', 'planLens-replace': '#c27d00', 'planLens-destroy': '#e51400', 'planLens-read': '#1a85ff' } },
  hc: { cls: 'vscode-high-contrast', vars: { foreground: '#ffffff', descriptionForeground: '#ffffff', 'editor-background': '#000000', 'sideBar-background': '#000000',
    focusBorder: '#f38518', contrastBorder: '#6fc3df', contrastActiveBorder: '#f38518', 'button-background': '#000000', 'button-foreground': '#ffffff', 'button-border': '#6fc3df',
    'charts-blue': '#3794ff', 'charts-yellow': '#ffd700', 'charts-orange': '#f38518', 'testing-iconPassed': '#73c991', errorForeground: '#f48771',
    'planLens-create': '#73c991', 'planLens-update': '#ffd700', 'planLens-replace': '#f38518', 'planLens-destroy': '#f48771', 'planLens-read': '#3794ff' } },
};

const page0 = readFileSync(join(root, 'webview/planView.html'), 'utf8');
const themeCss = (theme) => `:root{${Object.entries(themes[theme].vars).map(([k, v]) => `--vscode-${k}:${v}`).join(';')};--vscode-font-family:-apple-system,'Segoe UI',system-ui,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:'Cascadia Code',Menlo,monospace}body{background:${themes[theme].vars['sideBar-background']}}`;
// Keep the real CSP (file: standing in for the webview's cspSource) so blocked inline styles show up here.
const html = (theme) => page0
  .replace('{{codicon}}', 'vendor/codicon.css').replace('{{base}}', 'base.css').replace('{{css}}', 'planView.css')
  .replace('<link rel="stylesheet" href="vendor/codicon.css">', `<link rel="stylesheet" href="__theme-${theme}.css"><link rel="stylesheet" href="vendor/codicon.css">`)
  .replace('<script nonce="{{nonce}}" src="{{js}}"></script>', `<script nonce="render" src="__stub.js"></script><script nonce="render" src="planView.js"></script>`)
  .replace(/\{\{cspSource\}\}/g, 'file:').replace(/\{\{nonce\}\}/g, 'render')
  .replace('<body class="plan">', `<body class="plan ${themes[theme].cls}">`);

const settings0 = readFileSync(join(root, 'webview/settings.html'), 'utf8');
const settingsHtml = (theme) => settings0
  .replace('{{codicon}}', 'vendor/codicon.css').replace('{{base}}', 'base.css').replace('{{css}}', 'planView.css').replace('{{settingsCss}}', 'settings.css')
  .replace('<link rel="stylesheet" href="vendor/codicon.css">', `<link rel="stylesheet" href="__theme-${theme}.css"><link rel="stylesheet" href="vendor/codicon.css">`)
  .replace('<script nonce="{{nonce}}" src="{{js}}"></script>', `<script nonce="render" src="__stub.js"></script><script nonce="render" src="settings.js"></script>`)
  .replace(/\{\{cspSource\}\}/g, 'file:').replace(/\{\{nonce\}\}/g, 'render')
  .replace('<body class="plan settings">', `<body class="plan settings ${themes[theme].cls}">`);

mkdirSync(join(root, 'out-render'), { recursive: true });
writeFileSync(join(root, 'webview/__stub.js'), 'window.acquireVsCodeApi = () => ({ getState: () => undefined, setState: () => {}, postMessage: (m) => (window.__posted = [...(window.__posted || []), m]) });');
const browser = await chromium.launch();
let failures = 0;
for (const theme of Object.keys(themes)) {
  const file = join(root, `webview/__render-${theme}.html`);
  writeFileSync(file, html(theme));
  writeFileSync(join(root, `webview/__theme-${theme}.css`), themeCss(theme));
  for (const width of [260, 360, 500]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' }); // still frames: no animation mid-way
    page.on('pageerror', (e) => { failures++; console.log(`PAGE ERROR ${theme} ${width}: ${e.message}`); });
    page.on('console', (m) => /Content Security Policy/.test(m.text()) && (failures++, console.log(`CSP ${theme} ${width}: ${m.text().slice(0, 120)}`)));
    await page.goto('file://' + file);
    for (const [name, model] of Object.entries(fixtures)) {
      await page.evaluate((m) => window.postMessage({ type: 'model', model: m }, '*'), model);
      await page.waitForTimeout(120);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (over > 0) { failures++; console.log(`OVERFLOW ${theme} ${width} ${name}: ${over}px`); }
      if (name === 'ready') {
        // The bar strip: every bar drawn (at least 2px wide and some height).
        const bar = await page.evaluate(() => [...document.querySelectorAll('.pl-strip > i')].map((i) => [i.getBoundingClientRect().width, i.getBoundingClientRect().height]));
        if (!bar.length || bar.some(([w, hgt]) => w < 2 || hgt < 4)) { failures++; console.log(`EMPTY BAR ${theme} ${width}: ${JSON.stringify(bar)}`); }
      }
      if (name !== 'large') await page.screenshot({ path: join(root, `out-render/${name}-${theme}-${width}.png`), fullPage: true });
    }
    // The look's knobs (accent × corners × density) on one plan: knob-<accent>-<corners>-<density>.png.
    if (theme !== 'hc' && width === 360) {
      const knobs = [['aurora', 'sharp', 'comfortable'], ['sunset', 'round', 'compact'], ['forest', 'soft', 'comfortable'], ['terraform', 'round', 'comfortable'], ['mono', 'sharp', 'compact']];
      const stops = { aurora: ['#8b5cf6', '#3b82f6', '#06b6d4'], sunset: ['#ea6b3d', '#f08049', '#f49a62'], forest: ['#0f9f87', '#14b8a6', '#0ea5b5'], terraform: ['#5c4ee5', '#7b42bc', '#9d5ccf'] };
      for (const [accent, corners, density] of knobs) {
        const style = { colors: stops[accent], radius: { sharp: 3, soft: 6, round: 10 }[corners], density, motion: 'subtle' };
        await page.evaluate((m) => window.postMessage({ type: 'model', model: m }, '*'), { ...fixtures.ready, style });
        await page.waitForTimeout(120);
        await page.screenshot({ path: join(root, `out-render/knob-${accent}-${corners}-${density}-${theme}.png`) });
      }
    }
    // Pick mode: pick a module and a resource, check the overflow, and that Plan posts the targets.
    await page.evaluate((m) => { window.__posted = []; window.postMessage({ type: 'model', model: m }, '*'); }, fixtures.apply);
    await page.waitForTimeout(120);
    await page.click('button[title^="Pick targets"]');
    await page.click('.pl-mod[data-address="module.storage"]');
    await page.click('[data-address="databricks_catalog.diapason_fresh"]');
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 0) { failures++; console.log(`OVERFLOW ${theme} ${width} picking: ${over}px`); }
    await page.screenshot({ path: join(root, `out-render/picking-${theme}-${width}.png`), fullPage: true });
    await page.click('.pl-foot button.primary');
    const run = await page.evaluate(() => window.__posted.at(-1));
    if (JSON.stringify(run) !== JSON.stringify({ type: 'run', targets: ['module.storage', 'databricks_catalog.diapason_fresh'] })) {
      failures++; console.log(`PICK ${theme} ${width}: posted ${JSON.stringify(run)}`);
    }
    // Settings page: open it from the gear, set drift to Shown, check what is posted.
    await page.evaluate((m) => { window.__posted = []; window.postMessage({ type: 'model', model: m }, '*'); }, fixtures.rich);
    await page.waitForTimeout(120);
    await page.screenshot({ path: join(root, `out-render/richDiscreet-${theme}-${width}.png`), fullPage: true });
    // The gear opens the settings tab (the extension does it).
    await page.click('button[aria-label="Settings"]');
    if ((await page.evaluate(() => window.__posted.at(-1)?.type)) !== 'settings') { failures++; console.log(`GEAR ${theme} ${width}: does not post settings`); }
    await page.close();
  }
  // The settings tab: an editor-wide page and a narrow one; pick the Sunset accent, set drift to Shown.
  const sfile = join(root, `webview/__settings-${theme}.html`);
  writeFileSync(sfile, settingsHtml(theme));
  for (const width of [1100, 640]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await page.goto(`file://${sfile}`);
    await page.evaluate((m) => { window.__posted = []; window.postMessage({ type: 'model', model: m }, '*'); }, settingsPage);
    await page.waitForTimeout(150);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 0) { failures++; console.log(`OVERFLOW ${theme} ${width} settings: ${over}px`); }
    await page.screenshot({ path: join(root, `out-render/settings-${theme}-${width}.png`), fullPage: true });
    await page.click('.ps-swatch[title="Sunset"]');
    await page.click('.pl-seg[aria-label="Changed outside Terraform"] button:first-child');
    const posted = await page.evaluate(() => window.__posted.slice(-2));
    if (JSON.stringify(posted) !== JSON.stringify([{ type: 'setting', key: 'style.accent', value: 'sunset' }, { type: 'setting', key: 'sidebar.drift', value: 'shown' }])) {
      failures++; console.log(`SETTINGS ${theme} ${width}: posted ${JSON.stringify(posted)}`);
    }
    // The preview follows the pick at once.
    // The preview's primary button really is drawn with the picked gradient (not only the variable set).
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.ps-preview .pl-foot button.primary')).backgroundImage);
    if (!/234, 107, 61|ea6b3d/i.test(bg)) { failures++; console.log(`PREVIEW ${theme} ${width}: button ${bg.slice(0, 80)}`); }
    if (width === 1100) await page.screenshot({ path: join(root, `out-render/settings-sunset-${theme}.png`), fullPage: true });
    await page.close();
  }
}
await browser.close();
if (!process.env.KEEP) {
  for (const f of ['__stub.js', ...Object.keys(themes).flatMap((t) => [`__render-${t}.html`, `__settings-${t}.html`, `__theme-${t}.css`])]) require('node:fs').rmSync(join(root, 'webview', f));
}
console.log(failures ? `${failures} failure(s)` : 'render ok: no overflow');
process.exit(failures ? 1 : 0);
