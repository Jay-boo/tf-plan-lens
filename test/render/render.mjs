// Renders the sidebar webview with fixture models × themes × widths; fails on horizontal overflow.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fixtures } from './fixtures.mjs';

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
const html = (theme) => page0
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
  .replace('{{codicon}}', 'vendor/codicon.css').replace('{{base}}', 'base.css').replace('{{css}}', 'planView.css')
  .replace(/<script nonce="\{\{nonce\}\}" src="\{\{js\}\}"><\/script>/, `<script>window.acquireVsCodeApi = () => ({ postMessage: (m) => (window.__posted = [...(window.__posted || []), m]) });</script><script src="planView.js"></script>`)
  .replace('<html lang="en">', `<html lang="en" style="${Object.entries(themes[theme].vars).map(([k, v]) => `--vscode-${k}:${v}`).join(';')};--vscode-font-family:-apple-system,'Segoe UI',system-ui,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:'Cascadia Code',Menlo,monospace">`)
  .replace('<body>', `<body class="${themes[theme].cls}" style="background:${themes[theme].vars['sideBar-background']}">`);

mkdirSync(join(root, 'out-render'), { recursive: true });
const browser = await chromium.launch();
let failures = 0;
for (const theme of Object.keys(themes)) {
  const file = join(root, `webview/__render-${theme}.html`);
  writeFileSync(file, html(theme));
  for (const width of [260, 360, 500]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto('file://' + file);
    for (const [name, model] of Object.entries(fixtures)) {
      await page.evaluate((m) => window.postMessage({ type: 'model', model: m }, '*'), model);
      await page.waitForTimeout(120);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (over > 0) { failures++; console.log(`OVERFLOW ${theme} ${width} ${name}: ${over}px`); }
      if (name !== 'large') await page.screenshot({ path: join(root, `out-render/${name}-${theme}-${width}.png`), fullPage: true });
    }
    await page.close();
  }
}
await browser.close();
for (const theme of Object.keys(themes)) require('node:fs').rmSync(join(root, `webview/__render-${theme}.html`));
console.log(failures ? `${failures} overflow(s)` : 'render ok: no overflow');
process.exit(failures ? 1 : 0);
