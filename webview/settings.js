// Plan Lens settings, in an editor tab: every option, grouped, saved as VS Code settings as soon as it changes, and a
// live preview of the sidebar drawn with its own stylesheet.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let model;
  /** Changes not saved back yet: the preview follows them at once. */
  const pending = {};

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === false || v === null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(2)) if (kid !== undefined && kid !== null && kid !== false) el.append(kid);
    return el;
  }
  const icon = (name, cls) => h('i', { class: `codicon codicon-${name}${cls ? ' ' + cls : ''}`, 'aria-hidden': 'true' });
  const post = (type, extra) => vscode.postMessage({ type, ...extra });
  const value = (s) => (s.key in pending ? pending[s.key] : s.value);
  function set(s, v) {
    pending[s.key] = v;
    post('setting', { key: s.key, value: v });
    render();
  }

  const ACCENTS = { aurora: ['#8b5cf6', '#3b82f6', '#06b6d4'], sunset: ['#ea6b3d', '#f08049', '#f49a62'], forest: ['#0f9f87', '#14b8a6', '#0ea5b5'], terraform: ['#5c4ee5', '#7b42bc', '#9d5ccf'] };
  /** Hue (0–360) and saturation of a colour as the browser resolves it (hex, or a theme variable through a probe). */
  function hsOf(css) {
    const probe = document.body.appendChild(document.createElement('i'));
    probe.style.color = css;
    const rgb = (getComputedStyle(probe).color.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    probe.remove();
    const [r, g, b] = rgb.map((x) => x / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const hue = !d ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: hue * 60, s: max ? d / max : 0 };
  }
  /** Custom accents: the action whose colour a stop could be taken for (hue within 12°), so colour keeps its meaning. */
  function clash(colors) {
    for (const c of colors || []) {
      const a = hsOf(c);
      if (a.s < 0.25) continue;
      for (const k of ['create', 'update', 'replace', 'destroy', 'read']) {
        const b = hsOf(`var(--pl-${k})`);
        const dh = Math.abs(a.h - b.h);
        if (Math.min(dh, 360 - dh) < 12) return `${c} reads like the ${k} colour: a different hue keeps actions and accent apart.`;
      }
    }
    return '';
  }
  const parseColors = (s) => {
    const p = String(s).split(',').map((x) => x.trim()).filter(Boolean);
    return p.length >= 2 && p.length <= 3 && p.every((x) => /^#[0-9a-f]{6}$/i.test(x)) ? p : undefined;
  };
  /** The look the preview gets, from the values on screen (same rules as styleOf in settings.ts). */
  /** The environment the preview is shown as (its own accent, if it has one); undefined: the global accent. */
  let previewEnv;
  const isAccent = (v) => typeof v === 'string' && (v in ACCENTS || v === 'mono' || !!parseColors(v));
  /** Same rule as envAccentOf in settings.ts: the exact name (any case), then the first matching pattern. */
  function envAccentOf(env, map) {
    const entries = Object.entries(map || {}).filter(([, v]) => isAccent(v));
    const exact = entries.find(([k]) => k.toLowerCase() === env.toLowerCase());
    if (exact) return exact[1];
    const glob = (k) => new RegExp(`^${k.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
    const hit = entries.find(([k]) => k.includes('*') && glob(k).test(env));
    return hit && hit[1];
  }
  function look() {
    const get = (k) => value(model.settings.find((s) => s.key === k));
    const own = previewEnv ? envAccentOf(previewEnv, get('style.envAccents')) : undefined;
    const accent = own || get('style.accent');
    let colors = accent === 'mono' ? undefined : accent === 'custom' ? parseColors(get('style.customColors')) || ACCENTS.aurora : ACCENTS[accent] || parseColors(accent) || ACCENTS.aurora;
    if (colors && colors.length === 2) colors = [colors[0], colors[1], colors[0]];
    return { colors, radius: { sharp: 3, soft: 6, round: 10 }[get('style.corners')] || 3, density: get('style.density'), motion: get('style.motion') };
  }

  /** Per environment: each environment with the accents to pick from; Default follows the global accent. */
  function envAccents(s) {
    const map = value(s) || {};
    const envs = model.envs || [];
    if (!envs.length) return h('span', { class: 'help', text: 'No environment found yet: plan one, or set planLens.style.envAccents in VS Code settings (patterns like *prod* work).' });
    const options = [['', 'Default'], ['aurora', 'Aurora'], ['sunset', 'Sunset'], ['forest', 'Forest'], ['terraform', 'Terraform'], ['mono', 'Mono']];
    return h('div', { class: 'ps-envs' }, envs.map((env) => {
      const exact = Object.keys(map).find((k) => k.toLowerCase() === env.toLowerCase());
      const current = exact ? map[exact] : '';
      const viaPattern = !exact && envAccentOf(env, map);
      const pick = (v) => {
        const next = { ...map };
        if (exact) delete next[exact];
        if (v) next[env] = v;
        previewEnv = env;
        set(s, next);
      };
      return h('div', { class: `ps-env${previewEnv === env ? ' on' : ''}` },
        h('button', { class: 'ps-env-name', title: `Preview as ${env}`, onclick: () => { previewEnv = env; render(); } }, icon('server-environment'), h('span', { class: 'ell', text: env })),
        h('div', { class: 'ps-minis', role: 'radiogroup', 'aria-label': `Accent of ${env}` }, options.map(([v, label]) => {
          const c = ACCENTS[v];
          const on = v === current;
          return h('button', { class: `ps-mini${on ? ' on' : ''}${v === '' ? ' def' : ''}${v === 'mono' ? ' mono' : ''}`, role: 'radio', 'aria-checked': String(on), title: v === '' ? (viaPattern ? `Default (a pattern gives ${viaPattern})` : 'Default: the global accent') : label,
            style: c ? `background: linear-gradient(90deg, ${c.join(', ')})` : '', onclick: () => pick(v) });
        })),
        parseColors(current) ? h('span', { class: 'help mono', text: current }) : null);
    }));
  }

  function control(s) {
    const v = value(s);
    if (s.type === 'envAccents') return envAccents(s);
    if (s.key === 'style.accent') {
      return h('div', { class: 'ps-swatches', role: 'radiogroup', 'aria-label': s.label }, s.options.map((o) => {
        const c = o.value === 'custom' ? parseColors(value(model.settings.find((x) => x.key === 'style.customColors'))) : ACCENTS[o.value];
        const swatch = c ? `background: linear-gradient(90deg, ${c.join(', ')})` : '';
        return h('button', { class: `ps-swatch${o.value === v ? ' on' : ''}${o.value === 'mono' ? ' mono' : ''}`, role: 'radio', 'aria-checked': String(o.value === v), title: o.label, onclick: () => set(s, o.value) },
          h('i', { style: swatch }), h('span', { text: o.label }));
      }));
    }
    if (s.type === 'visibility' || s.type === 'choice') {
      const options = s.type === 'choice' ? s.options : ['shown', 'discreet', 'hidden'].map((x) => ({ value: x, label: x[0].toUpperCase() + x.slice(1) }));
      return h('div', { class: 'pl-seg', role: 'radiogroup', 'aria-label': s.label }, options.map((o) =>
        h('button', { class: o.value === v ? 'on' : '', role: 'radio', 'aria-checked': String(o.value === v), onclick: () => set(s, o.value) }, o.label)));
    }
    if (s.type === 'boolean') {
      return h('button', { class: `pl-switch${v ? ' on' : ''}`, role: 'switch', 'aria-checked': String(!!v), 'aria-label': s.label, onclick: () => set(s, !v) }, h('i'));
    }
    const input = h('input', { class: 'pl-input', type: 'text', value: v, placeholder: s.placeholder || '', 'aria-label': s.label, spellcheck: 'false' });
    input.addEventListener('change', () => {
      if (s.type === 'colors' && !parseColors(input.value)) { input.classList.add('bad'); return; }
      if (input.value.trim() !== v) set(s, input.value.trim());
    });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
    return input;
  }

  function settingRow(s) {
    // Custom colours only matter with the Custom accent.
    if (s.key === 'style.customColors' && value(model.settings.find((x) => x.key === 'style.accent')) !== 'custom') return null;
    const warn = s.key === 'style.customColors' ? clash(parseColors(value(s))) : '';
    return h('div', { class: `pl-set-row t-${s.type}` },
      h('div', { class: 'txt' }, h('span', { class: 'lbl', text: s.label }), h('span', { class: 'help', text: s.help + (s.workspace ? ' Saved for this workspace.' : '') }),
        warn ? h('span', { class: 'help warn' }, icon('warning'), h('span', { text: ` ${warn}` })) : null),
      control(s));
  }

  /** A miniature sidebar with sample changes, drawn by planView.css with the look on screen. */
  function preview() {
    const st = look();
    // On the page root, like the sidebar: --pl-grad is computed there from these (and the page takes the accent too).
    const root = document.documentElement.style;
    const [g1, g2, g3] = st.colors || [];
    for (const [k, v] of [['--pl-g1', g1], ['--pl-g2', g2], ['--pl-g3', g3]]) v ? root.setProperty(k, v) : root.removeProperty(k);
    root.setProperty('--pl-r', `${st.radius}px`);
    document.body.dataset.accent = st.colors ? 'gradient' : 'mono';
    const box = h('div', { class: 'ps-preview', 'data-density': st.density, 'data-motion': st.motion });
    const envName = previewEnv || (model.envs && model.envs[0]) || 'prod';
    const kpi = (k, n, label) => h('div', { class: `pl-kpi k-${k}${n === 3 ? ' most' : ''}` }, h('b', { text: String(n) }), h('span', { text: label }));
    const strip = ['destroy', 'replace', 'update', 'update', 'update', 'create', 'create'];
    box.append(
      h('header', { class: 'pl-head' },
        h('div', { class: 'top' }, h('span', { class: 'pl-env' }, icon('server-environment'), h('span', { class: 'lbl', text: envName })), h('span', { class: 'pl-state ok' }, icon('check')), h('span', { class: 'grow' })),
        h('div', { class: 'pl-kpis' }, kpi('create', 2, 'create'), kpi('update', 3, 'update'), kpi('replace', 1, 'replace'), kpi('destroy', 1, 'destroy')),
        h('div', { class: 'pl-strip' }, strip.map((a) => h('i', { class: `k-${a}` })))),
      h('div', { class: 'pl-body' },
        h('div', { class: 'gl-ck' }, h('span', { class: 'name' }, icon('chevron-down', 'chev'), icon('warning', 'warn'), 'Needs a look'), h('span', { class: 'n', text: '2' })),
        h('div', { class: 'gl-orow pl-orow k-replace' }, h('div', { class: 'grow' }, h('div', { class: 'head' }, h('span', { class: 'name', text: 'aws_dynamodb_table.orders' }), h('span', { class: 'pl-verb k-replace' }, h('span', { class: 'vs', text: '-/+' }), 'replace')),
          h('div', { class: 'sub' }, h('span', {}, 'forced by ', h('span', { class: 'mono hl', text: 'hash_key' }))))),
        h('div', { class: 'gl-orow pl-orow k-destroy' }, h('div', { class: 'grow' }, h('div', { class: 'head' }, h('span', { class: 'name', text: 'aws_iam_role.worker' }), h('span', { class: 'pl-verb k-destroy' }, h('span', { class: 'vs', text: '−' }), 'destroy')),
          h('div', { class: 'sub' }, h('span', { text: 'removed from code' })))),
        h('div', { class: 'gl-ck' }, h('span', { class: 'name' }, icon('chevron-down', 'chev'), icon('edit', 'k-update'), 'Updates'), h('span', { class: 'n', text: '3' })),
        h('div', { class: 'pl-box' }, ['aws_sqs_queue.orders', 'aws_s3_bucket.assets', 'aws_ssm_parameter.replicas'].map((n) =>
          h('div', { class: 'pl-row k-update' }, h('span', { class: 'pl-sym k-update', text: '~' }), h('span', { class: 'name', text: n }), h('span', { class: 'dir' }))))),
      h('footer', { class: 'pl-foot' }, h('div', { class: 'gl-btn-pair' }, h('button', {}, icon('refresh'), h('span', { text: 'Re-plan' })), h('button', { class: 'primary' }, icon('rocket'), h('span', { text: `Apply ${envName}` })))));
    // Preview as: the global accent, or one environment's own.
    const as = (model.envs || []).length ? h('div', { class: 'ps-as' }, h('span', { text: 'as' }),
      [undefined, ...model.envs].slice(0, 8).map((e) => h('button', { class: previewEnv === e ? 'on' : '', onclick: () => { previewEnv = e; render(); } }, e || 'Global'))) : null;
    return h('aside', { class: 'ps-side' }, h('div', { class: 'ps-side-title', text: 'Preview' }), as, box, h('div', { class: 'ps-hint', text: 'Hover the cards to see the effect.' }));
  }

  function render() {
    if (!model) return;
    const groups = [...new Set(model.settings.map((s) => s.group))];
    const cards = groups.map((g) => h('section', { class: 'pl-set-card' }, h('div', { class: 'pl-set-group', text: g }),
      model.settings.filter((s) => s.group === g).map(settingRow)));
    cards.push(h('section', { class: 'pl-set-card' }, h('div', { class: 'pl-set-group', text: 'Environments' }),
      h('div', { class: 'pl-set-row' }, h('div', { class: 'txt' }, h('span', { class: 'lbl', text: 'Where environments come from' }), h('span', { class: 'help mono', text: model.envFolder || 'Terraform folders in the workspace' })),
        h('button', { class: 'ghost', onclick: () => post('envFolder') }, 'Change…')),
      h('div', { class: 'pl-set-row' }, h('div', { class: 'txt' }, h('span', { class: 'lbl', text: 'Terraform workspaces' }), h('span', { class: 'help', text: 'List the workspaces of a remote backend, so each can be planned.' })),
        h('button', { class: 'ghost', onclick: () => post('findWorkspaces') }, 'Find…'))));
    const y = window.scrollY;
    app.replaceChildren(
      h('header', { class: 'ps-top' }, h('div', { class: 'ps-logo' }, icon('settings-gear')),
        h('div', { class: 'grow' }, h('h1', { text: 'Plan Lens settings' }), h('span', { class: 'help', text: 'Saved as planLens.* settings as soon as you change them.' })),
        h('button', { class: 'ghost', title: 'All Plan Lens settings in VS Code', onclick: () => post('settings') }, icon('link-external'), h('span', { text: 'Open in VS Code settings' }))),
      h('div', { class: 'ps-grid' }, h('div', { class: 'ps-main' }, cards), preview()));
    window.scrollTo(0, y);
  }

  window.addEventListener('message', (e) => {
    if (e.data.type !== 'model') return;
    model = e.data.model;
    // What was saved is now the truth.
    for (const s of model.settings) if (s.key in pending && pending[s.key] === s.value) delete pending[s.key];
    render();
  });
  post('ready');
})();
