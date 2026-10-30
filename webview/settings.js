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

  const ACCENTS = { aurora: ['#8b5cf6', '#3b82f6', '#06b6d4'], sunset: ['#f43f5e', '#f97316', '#f59e0b'], forest: ['#10b981', '#14b8a6', '#06b6d4'], terraform: ['#7b42bc', '#5c4ee5', '#a87ff0'] };
  const parseColors = (s) => {
    const p = String(s).split(',').map((x) => x.trim()).filter(Boolean);
    return p.length >= 2 && p.length <= 3 && p.every((x) => /^#[0-9a-f]{6}$/i.test(x)) ? p : undefined;
  };
  /** The look the preview gets, from the values on screen (same rules as styleOf in settings.ts). */
  function look() {
    const get = (k) => value(model.settings.find((s) => s.key === k));
    const accent = get('style.accent');
    let colors = accent === 'mono' ? undefined : accent === 'custom' ? parseColors(get('style.customColors')) || ACCENTS.aurora : ACCENTS[accent] || ACCENTS.aurora;
    if (colors && colors.length === 2) colors = [colors[0], colors[1], colors[0]];
    return { colors, radius: { sharp: 3, soft: 6, round: 10 }[get('style.corners')] || 3, density: get('style.density'), motion: get('style.motion') };
  }

  function control(s) {
    const v = value(s);
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
    return h('div', { class: `pl-set-row t-${s.type}` },
      h('div', { class: 'txt' }, h('span', { class: 'lbl', text: s.label }), h('span', { class: 'help', text: s.help + (s.workspace ? ' Saved for this workspace.' : '') })),
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
    const kpi = (k, n, label) => h('div', { class: `pl-kpi k-${k}` }, h('b', { text: String(n) }), h('span', { text: label }));
    const strip = ['destroy', 'replace', 'update', 'update', 'update', 'create', 'create'];
    box.append(
      h('header', { class: 'pl-head' },
        h('div', { class: 'top' }, h('span', { class: 'pl-env' }, icon('server-environment'), h('span', { class: 'lbl', text: 'prod' })), h('span', { class: 'pl-state ok' }, icon('check')), h('span', { class: 'grow' })),
        h('div', { class: 'pl-kpis' }, kpi('create', 2, 'create'), kpi('update', 3, 'update'), kpi('replace', 1, 'replace'), kpi('destroy', 1, 'destroy')),
        h('div', { class: 'pl-strip' }, strip.map((a) => h('i', { class: `k-${a}` })))),
      h('div', { class: 'pl-body' },
        h('div', { class: 'gl-ck' }, h('span', { class: 'name' }, icon('chevron-down', 'chev'), icon('warning', 'warn'), 'Needs a look'), h('span', { class: 'n', text: '2' })),
        h('div', { class: 'gl-orow pl-orow k-replace' }, h('div', { class: 'grow' }, h('div', { class: 'head' }, h('span', { class: 'name', text: 'aws_dynamodb_table.orders' }), h('span', { class: 'pl-verb k-replace', text: 'replace' })),
          h('div', { class: 'sub' }, h('span', {}, 'forced by ', h('span', { class: 'mono hl', text: 'hash_key' }))))),
        h('div', { class: 'gl-orow pl-orow k-destroy' }, h('div', { class: 'grow' }, h('div', { class: 'head' }, h('span', { class: 'name', text: 'aws_iam_role.worker' }), h('span', { class: 'pl-verb k-destroy', text: 'destroy' })),
          h('div', { class: 'sub' }, h('span', { text: 'removed from code' })))),
        h('div', { class: 'gl-ck' }, h('span', { class: 'name' }, icon('chevron-down', 'chev'), icon('edit', 'k-update'), 'Updates'), h('span', { class: 'n', text: '3' })),
        h('div', { class: 'pl-box' }, ['aws_sqs_queue.orders', 'aws_s3_bucket.assets', 'aws_ssm_parameter.replicas'].map((n) =>
          h('div', { class: 'pl-row k-update' }, h('span', { class: 'pl-sym k-update', text: '~' }), h('span', { class: 'name', text: n }), h('span', { class: 'dir' }))))),
      h('footer', { class: 'pl-foot' }, h('div', { class: 'gl-btn-pair' }, h('button', {}, icon('refresh'), h('span', { text: 'Re-plan' })), h('button', { class: 'primary' }, icon('rocket'), h('span', { text: 'Apply prod' })))));
    return h('aside', { class: 'ps-side' }, h('div', { class: 'ps-side-title', text: 'Preview' }), box, h('div', { class: 'ps-hint', text: 'Hover the cards to see the effect.' }));
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
