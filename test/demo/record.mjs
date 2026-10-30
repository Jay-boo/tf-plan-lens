// Records the README GIFs: a real VS Code with Plan Lens installed, on the acme-shop project of make-project.mjs
// (applied for real on LocalStack), driven by Playwright. A fake cursor, click ripples and captions are drawn in the
// page; frames come from the Chromium screencast at 2x and ffmpeg turns them into GIFs. Borrowed from Gitland's.
//   node test/demo/record.mjs [scene…] [--keep]     default: every scene; --keep keeps the frames
//   node test/demo/record.mjs explore                screenshots of each view, to write scenes
// Output: media/readme/<scene>.gif (+ test/demo/out/<scene>.mp4 for social posts)
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { SCENES } from './scenes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = path.join(here, 'out');
// playwright-core and a Linux VS Code build are borrowed from the sibling projects (see test/render, test/e2e).
const { _electron } = createRequire(import.meta.url)(path.resolve(root, '../gitland/node_modules/playwright-core'));
const testDir = path.resolve(root, '../dataframe-lens/.vscode-test');
const vscodeDir = fs.readdirSync(testDir).filter((d) => d.startsWith('vscode-linux-x64-')).sort().pop();
const VSCODE = path.join(testDir, vscodeDir);
const WORKSPACE = path.join(out, 'acme-shop');
const SIZE = { width: 1280, height: 800 };

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const names = args.filter((a) => !a.startsWith('--'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

function sh(cmd, argv, opts = {}) {
  return execFileSync(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString();
}

/** Packages Plan Lens and installs it in a throwaway extensions folder, with HashiCorp's for syntax colours. */
function installExtensions() {
  const vsix = path.join(out, 'plan-lens.vsix');
  sh('node', ['-r', path.join(root, 'scripts/file-shim.cjs'), path.resolve(root, '../gitland/node_modules/@vscode/vsce/vsce'), 'package', '--no-dependencies', '-o', vsix], { cwd: root });
  fs.rmSync(path.join(out, 'extensions'), { recursive: true, force: true });
  // bin/code hands over to the Windows VS Code under WSL: call the CLI entry point directly.
  sh(path.join(VSCODE, 'code'), [path.join(VSCODE, 'resources/app/out/cli.js'), '--extensions-dir', path.join(out, 'extensions'), '--user-data-dir', path.join(out, 'user-data'),
    '--install-extension', vsix, '--install-extension', 'hashicorp.terraform'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } });
}

const SETTINGS = {
  'workbench.colorTheme': 'Default Dark Modern',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.layoutControl.enabled': false,
  'workbench.editor.empty.hint': 'hidden',
  'workbench.enableExperiments': false,
  'chat.commandCenter.enabled': false,
  'workbench.commandPalette.history': 0,
  'window.commandCenter': true,
  'editor.minimap.enabled': false,
  'editor.fontSize': 14,
  'editor.lineHeight': 22,
  'editor.stickyScroll.enabled': false,
  'editor.hover.delay': 200,
  'git.autofetch': false,
  'git.openRepositoryInParentFolders': 'never',
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.ignoreRecommendations': true,
  'security.workspace.trust.enabled': false,
  'files.autoSave': 'off',
  'editor.inlayHints.enabled': 'on',
  'terraform.languageServer.enable': false,
  // Hides the Copilot sign-in and chat buttons.
  'chat.disableAIFeatures': true,
};

/** Starts VS Code on a fresh acme-shop (fresh LocalStack) and returns the director for a scene. */
async function launch(settings = {}) {
  sh('node', [path.join(here, 'make-project.mjs'), WORKSPACE]);
  const userData = path.join(out, 'user-data');
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'User/settings.json'), JSON.stringify({ ...SETTINGS, ...settings }, null, 2));
  const app = await _electron.launch({
    executablePath: path.join(VSCODE, 'code'),
    args: [WORKSPACE, '--extensions-dir', path.join(out, 'extensions'), '--user-data-dir', userData, '--disable-workspace-trust', '--password-store=basic',
      '--skip-welcome', '--skip-release-notes', '--force-device-scale-factor=2', '--disable-gpu-sandbox'],
    // Providers from the demo's plugin cache: plans and values start in seconds.
    env: { ...env, TF_PLUGIN_CACHE_DIR: path.join(os.homedir(), '.cache/plan-lens-demo/plugins') },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, ...size }), SIZE);
  await page.waitForSelector('.monaco-workbench', { timeout: 60000 });
  await sleep(2500);
  return new Director(app, page);
}

class Director {
  constructor(app, page) {
    this.app = app;
    this.page = page;
    this.pos = { x: SIZE.width / 2, y: SIZE.height / 2 };
    this.frames = [];
  }

  // ------------------------------------------------------------------ overlay
  async overlay() {
    await this.page.evaluate(({ x, y }) => {
      if (document.getElementById('demo-cursor')) return;
      const style = document.createElement('style');
      style.textContent = `
        #demo-cursor { position: fixed; z-index: 2147483647; pointer-events: none; width: 22px; height: 22px; left: 0; top: 0; filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
        .demo-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;
          border: 2px solid #6ea8ff; background: rgba(110,168,255,.25); animation: demo-ripple .45s ease-out forwards; }
        @keyframes demo-ripple { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.4); opacity: 0 } }
        #demo-caption { position: fixed; z-index: 2147483645; pointer-events: none; left: 50%; bottom: 46px; transform: translate(-50%, 8px); opacity: 0;
          transition: opacity .25s, transform .25s; padding: 9px 18px; border-radius: 999px; background: rgba(20,24,33,.92); color: #fff;
          font: 600 15px/1.2 system-ui, 'Segoe UI', sans-serif; border: 1px solid rgba(110,168,255,.55); box-shadow: 0 6px 24px rgba(0,0,0,.45); white-space: nowrap; }
        #demo-caption.on { opacity: 1; transform: translate(-50%, 0); }
        #demo-caption kbd { font: 600 13px ui-monospace, monospace; padding: 1px 6px; border-radius: 5px; background: rgba(255,255,255,.14); }`;
      document.head.appendChild(style);
      const c = document.createElement('div');
      c.id = 'demo-cursor';
      // The workbench enforces Trusted Types: no innerHTML.
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 22 22');
      svg.setAttribute('width', '22');
      svg.setAttribute('height', '22');
      const arrow = document.createElementNS(ns, 'path');
      for (const [k, v] of Object.entries({ d: 'M3 2 L3 18 L7.5 14 L10.5 20.5 L13 19.4 L10.1 13 L16 13 Z', fill: '#fff', stroke: '#111', 'stroke-width': '1.3', 'stroke-linejoin': 'round' })) arrow.setAttribute(k, v);
      svg.appendChild(arrow);
      c.appendChild(svg);
      c.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
      document.body.appendChild(c);
      const cap = document.createElement('div');
      cap.id = 'demo-caption';
      document.body.appendChild(cap);
    }, this.pos);
  }

  async caption(html) {
    await this.page.evaluate((h) => {
      const cap = document.getElementById('demo-caption');
      if (!h) return cap.classList.remove('on');
      // Only <b> and <kbd> are used: build them by hand (Trusted Types).
      cap.replaceChildren();
      for (const part of h.split(/(<b>.*?<\/b>|<kbd>.*?<\/kbd>)/)) {
        const m = /^<(b|kbd)>(.*)<\/\1>$/.exec(part);
        if (m) {
          const el = document.createElement(m[1]);
          el.textContent = m[2];
          cap.appendChild(el);
        } else if (part) {
          cap.appendChild(document.createTextNode(part));
        }
      }
      cap.classList.add('on');
    }, html || '');
  }

  // ------------------------------------------------------------------ targets
  /** First visible element matching `sel` in the workbench or any webview, as a Playwright locator. */
  async find(sel, { timeout = 15000, nth = 0 } = {}) {
    const end = Date.now() + timeout;
    for (;;) {
      for (const f of this.page.frames()) {
        const loc = f.locator(sel);
        const n = await loc.count().catch(() => 0);
        const visible = [];
        for (let i = 0; i < n && visible.length <= nth; i++) {
          if (await loc.nth(i).isVisible().catch(() => false)) visible.push(loc.nth(i));
        }
        if (visible[nth]) return visible[nth];
      }
      if (Date.now() > end) throw new Error(`not found: ${sel}`);
      await sleep(200);
    }
  }

  async point(target, at = 'center') {
    if (typeof target === 'object' && 'x' in target && !target.sel) return target;
    const loc = typeof target === 'string' ? await this.find(target) : await this.find(target.sel, target);
    const b = await loc.boundingBox();
    if (!b) throw new Error(`no box: ${target.sel ?? target}`);
    const dx = target.dx ?? 0;
    const dy = target.dy ?? 0;
    if (at === 'left' || target.at === 'left') return { x: b.x + Math.min(24, b.width / 2) + dx, y: b.y + b.height / 2 + dy };
    return { x: b.x + b.width / 2 + dx, y: b.y + b.height / 2 + dy };
  }

  // ------------------------------------------------------------------ actions
  async move(target, ms = 550) {
    const to = await this.point(target);
    const from = { ...this.pos };
    const steps = Math.max(8, Math.round(ms / 40));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      const x = from.x + (to.x - from.x) * e;
      const y = from.y + (to.y - from.y) * e;
      await this.page.mouse.move(x, y);
      await this.page.evaluate(([x, y]) => {
        const c = document.getElementById('demo-cursor');
        if (c) c.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
      }, [x, y]);
    }
    this.pos = to;
  }

  async click(target, { button = 'left', double = false, modifiers = [], ms } = {}) {
    if (target) await this.move(target, ms);
    await sleep(120);
    await this.page.evaluate(({ x, y }) => {
      const r = document.createElement('div');
      r.className = 'demo-ripple';
      r.style.left = `${x}px`;
      r.style.top = `${y}px`;
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 500);
    }, this.pos);
    for (const m of modifiers) await this.page.keyboard.down(m);
    await this.page.mouse.click(this.pos.x, this.pos.y, { button, clickCount: double ? 2 : 1 });
    for (const m of modifiers) await this.page.keyboard.up(m);
    await sleep(250);
  }

  async hover(target, ms = 1500) {
    await this.move(target);
    await sleep(ms);
  }

  async type(text, delay = 55) {
    await this.page.keyboard.type(text, { delay });
  }

  key(k) {
    return this.page.keyboard.press(k);
  }

  wait(ms) {
    return sleep(ms);
  }

  /** Runs a command from the palette (shown when recording). */
  async cmd(title, { typeDelay = 35, pause = 350 } = {}) {
    // A focused webview keeps F1 to itself: give the focus back to the editor first.
    await this.page.locator('.monaco-workbench .part.editor').first().focus().catch(() => {});
    await this.key('F1');
    await this.page.waitForSelector('.quick-input-widget:not([style*="display: none"]) input', { timeout: 10000 });
    await this.type(title, typeDelay);
    await sleep(pause);
    await this.key('Enter');
    await sleep(400);
  }

  /** Opens a file in the editor (Ctrl+P), cursor on `line` when given. */
  async open(file, line) {
    await this.key('Control+P');
    await this.page.waitForSelector('.quick-input-widget:not([style*="display: none"]) input', { timeout: 10000 });
    await this.type(line ? `${file}:${line}` : file, 25);
    await sleep(500);
    await this.key('Enter');
    await sleep(700);
  }

  /** Picks the environment in the quick pick Plan Lens shows. */
  async pickEnv(name) {
    await this.page.waitForSelector('.quick-input-widget:not([style*="display: none"]) input', { timeout: 30000 });
    await sleep(500);
    await this.type(name, 90);
    await sleep(500);
    await this.key('Enter');
  }

  /** Waits for something in the Plan Lens sidebar (a selector in its webview). */
  until(sel, timeout = 180000) {
    return this.find(sel, { timeout });
  }

  /** Waits until nothing matches `sel` any more (in the workbench or a webview). */
  async gone(sel, timeout = 180000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      let n = 0;
      for (const f of this.page.frames()) n += await f.locator(sel).count().catch(() => 0);
      if (!n) return;
      await sleep(300);
    }
    throw new Error(`still there: ${sel}`);
  }

  async shotTo(file) {
    await this.page.screenshot({ path: file });
  }

  async closeAll() {
    await this.cmd('View: Close All Editors', { typeDelay: 0, pause: 300 });
    await this.page.locator('.notification-toast .codicon-close').first().click({ timeout: 500 }).catch(() => {});
  }

  // ------------------------------------------------------------------ capture
  async start() {
    await this.overlay();
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.frameDir = fs.mkdtempSync(path.join(out, 'frames-'));
    this.frames = [];
    this.capturing = true;
    this.cdp.on('Page.screencastFrame', (f) => {
      if (!this.capturing) return;
      const file = path.join(this.frameDir, `${String(this.frames.length).padStart(5, '0')}.jpg`);
      fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
      this.frames.push({ file, t: f.metadata.timestamp });
      this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, everyNthFrame: 1 });
    await sleep(300);
  }

  async stop() {
    await sleep(200);
    this.capturing = false;
    await this.cdp.send('Page.stopScreencast');
    return { frames: this.frames, end: Date.now() / 1000, dir: this.frameDir };
  }

  async shot(name) {
    await this.page.screenshot({ path: path.join(out, 'explore', `${name}.png`) });
  }

  close() {
    return this.app.close();
  }
}

/** Frames (variable rate) → GIF at 1x, plus an MP4 at 2x. */
function encode(name, { frames, end, dir }, { fps = 12, width = 1280 } = {}) {
  if (frames.length < 2) throw new Error(`${name}: only ${frames.length} frames captured`);
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.t ?? Math.min(end, f.t + 2)) - f.t).toFixed(3)}`).join('\n');
  const concat = path.join(dir, 'list.txt');
  fs.writeFileSync(concat, `${list}\nfile '${frames[frames.length - 1].file}'\n`);
  const gif = path.join(root, 'media/readme', `${name}.gif`);
  fs.mkdirSync(path.dirname(gif), { recursive: true });
  const filters = `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  sh('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concat, '-vf', filters, '-loop', '0', gif]);
  sh('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concat, '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', path.join(out, `${name}.mp4`)]);
  if (!keep) fs.rmSync(dir, { recursive: true, force: true });
  const seconds = frames[frames.length - 1].t - frames[0].t;
  console.log(`  ${name}.gif  ${(fs.statSync(gif).size / 1048576).toFixed(1)} MB, ${seconds.toFixed(1)} s, ${frames.length} frames`);
}

fs.mkdirSync(out, { recursive: true });
console.log(`VS Code ${vscodeDir.replace('vscode-linux-x64-', '')}: packaging and installing Plan Lens…`);
installExtensions();
for (const name of names.length ? names : Object.keys(SCENES).filter((n) => n !== 'explore')) {
  const scene = SCENES[name];
  if (!scene) throw new Error(`unknown scene ${name}; known: ${Object.keys(SCENES).join(', ')}`);
  console.log(`● ${name}`);
  const d = await launch(scene.settings);
  try {
    await d.overlay();
    await scene.setup?.(d);
    if (scene.record === false) {
      fs.mkdirSync(path.join(out, 'explore'), { recursive: true });
      await scene.run(d);
    } else {
      await d.start();
      await scene.run(d);
      encode(name, await d.stop(), scene.gif);
      await scene.after?.(d);
    }
  } catch (e) {
    fs.mkdirSync(path.join(out, 'explore'), { recursive: true });
    await d.shot(`${name}-error`).catch(() => {});
    if (d.capturing) await d.stop().catch(() => {});
    console.error(`  ✘ ${name}: ${e.message} (screenshot: test/demo/out/explore/${name}-error.png)`);
    process.exitCode = 1;
  } finally {
    await d.close().catch(() => {});
  }
}
