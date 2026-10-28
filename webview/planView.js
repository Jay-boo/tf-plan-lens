// Plan Lens sidebar. Renders the ViewModel posted by the extension; plan data only ever goes into textContent.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const ICON = { create: 'add', update: 'edit', replace: 'sync', destroy: 'trash', forget: 'trash', read: 'eye', noop: 'circle-small' };
  const MAX_UPDATES = 5;
  let model;
  let showAllUpdates = false;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === false || v === null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== undefined && kid !== null && kid !== false) el.append(kid);
    return el;
  }
  const icon = (name, cls) => h('i', { class: `codicon codicon-${name}${cls ? ' ' + cls : ''}`, 'aria-hidden': 'true' });
  const post = (type, extra) => vscode.postMessage({ type, ...extra });

  function ctxbar(m) {
    return h('div', { class: 'pl-ctxbar' },
      icon('server-environment', 'muted'),
      h('button', { class: `pl-pill${m.env ? '' : ' none'}`, title: 'Pick environment', onclick: () => post('pickEnv') },
        m.env || 'Environment', icon('chevron-down')),
      h('span', { class: 'grow' }),
      h('div', { class: 'pl-seg', role: 'group', 'aria-label': 'Plan source' },
        h('button', { class: m.loaded ? '' : 'on', title: 'Run terraform plan', onclick: () => post('run') }, icon('play'), h('span', { class: 'lbl', text: 'Run' })),
        h('button', { class: m.loaded ? 'on' : '', title: 'Load a plan file', onclick: () => post('load') }, icon('file'), h('span', { class: 'lbl', text: 'Load' }))));
  }

  function card(m) {
    const running = m.state === 'running';
    const head = h('div', { class: 'head' },
      icon(running ? 'loading' : 'checklist', running ? 'spin' : ''),
      h('span', { class: 'pl-title grow ell', text: m.title }),
      m.state === 'ready' ? h('button', { class: 'pl-icon-btn', title: 'Clear plan', 'aria-label': 'Clear plan', onclick: () => post('clear') }, icon('close')) : null);
    const kids = [head];
    if (m.state === 'empty') {
      kids.push(h('div', { class: 'sub', text: m.envs.length ? 'Run a plan for an environment, or load a plan file.' : 'No environments found. Load a plan file, or set planLens.root.' }));
    } else {
      if (running) kids.push(h('div', { class: 'sub ell', text: 'Planning… terraform init, then plan' }));
      else {
        // The folder name may be long; only it gets cut, the age and version stay visible.
        const [origin, ...rest] = m.sub.split(' · ');
        kids.push(h('div', { class: 'sub meta' }, h('span', { class: 'ell', title: origin, text: origin }), rest.length ? h('span', { class: 'rest', text: ' · ' + rest.join(' · ') }) : null));
      }
    }
    if (m.error) kids.push(h('div', { class: 'err' }, icon('error'), h('span', { text: m.error })));
    if (m.state !== 'empty' && !running) {
      const stats = h('div', { class: 'pl-stats' });
      for (const a of ['create', 'update', 'replace', 'destroy']) {
        if (m.counts[a]) stats.append(h('span', { class: `pl-stat k-${a}` }, h('b', { text: String(m.counts[a]) }), a));
      }
      if (!stats.childElementCount) stats.append(h('span', { class: 'pl-stat' }, icon('check'), 'No changes'));
      kids.push(stats);
    }
    if (m.state !== 'empty') {
      const bar = h('div', { class: `pl-split${running ? ' busy' : ''}`, role: running ? 'progressbar' : 'img', 'aria-label': running ? 'Planning' : 'Change mix' });
      if (running) bar.append(h('i'));
      else for (const b of m.bar) bar.append(h('i', { class: `k-${b.action}`, style: `width:${b.pct}%` }));
      kids.push(bar);
    }
    const env = m.env ? ` ${m.env}` : '';
    const btns = h('div', { class: 'pl-btns' });
    if (running) {
      btns.append(h('button', { class: 'pl-btn primary', onclick: () => post('cancel') }, icon('debug-stop'), 'Cancel'));
    } else if (m.state === 'empty') {
      btns.append(h('button', { class: 'pl-btn primary', onclick: () => post('run') }, icon('play'), `Run plan${env}`));
      btns.append(h('button', { class: 'pl-btn', onclick: () => post('load') }, icon('folder-opened'), 'Load file'));
    } else {
      btns.append(h('button', { class: 'pl-btn primary', onclick: () => post(m.loaded ? 'load' : 'run') }, icon('refresh'), m.loaded ? 'Load another' : `Re-plan${env}`));
    }
    if (m.state !== 'empty' || m.error) btns.append(h('button', { class: 'pl-btn', onclick: () => post('log') }, icon('output'), 'Log'));
    kids.push(btns);
    if (m.state === 'empty' && m.envs.length > 1) {
      kids.push(h('div', { class: 'pl-envs' }, m.envs.map((e) => h('button', { class: 'pl-chip', title: `Plan ${e}`, onclick: () => post('run', { env: e }) }, e))));
    }
    return h('section', { class: 'pl-task', 'aria-label': 'Plan' }, kids);
  }

  function heading(iconName, iconCls, label, n) {
    return h('div', { class: 'pl-hd' }, icon(iconName, iconCls), label, h('span', { class: 'n', text: String(n) }));
  }

  function box(it, hot) {
    const sub = h('div', { class: 'pl-sub' });
    if (hot) sub.append(h('span', { class: `pl-chip k-${it.action}`, text: it.action }));
    for (const s of it.sub) {
      const m = /^forced by (.*)$/.exec(s);
      if (m) sub.append(h('span', {}, 'forced by ', h('span', { class: 'mono', style: 'color:var(--pl-bright)', text: m[1] })));
      else sub.append(h('span', { class: it.action === 'update' ? 'mono' : '', text: s }));
    }
    if (it.module) sub.append(h('span', { class: 'faint ell', text: (sub.childElementCount ? '· ' : '') + it.module }));
    else if (it.loc && !hot) sub.append(h('span', { class: 'faint', text: it.loc }));
    const tip = `${it.address}${it.loc ? `\n${it.loc}` : ''}${it.orphan ? '\nNot in the code: click to copy the address' : ''}`;
    return h('button', {
      class: `pl-box${hot ? ' hot' : ''} k-${it.action}`, title: tip, 'data-address': it.address,
      onclick: () => post(it.orphan ? 'copy' : 'open', { address: it.address }),
    },
    h('span', { class: `pl-glyph k-${it.action}` }, icon(ICON[it.action])),
    h('div', { class: 'grow' }, h('div', { class: 'pl-name', text: it.title }), sub),
    icon(it.orphan ? 'circle-slash' : 'go-to-file', 'go'));
  }

  function row(it) {
    return h('button', {
      class: `pl-orow k-${it.action}`, title: it.address, 'data-address': it.address,
      onclick: () => post(it.orphan ? 'copy' : 'open', { address: it.address }),
    }, h('span', { class: 'dot' }), h('span', { class: 'name ell grow', text: it.title }), it.loc ? h('span', { class: 'loc', text: it.loc }) : null);
  }

  function render() {
    const m = model;
    if (!m) return;
    const kids = [ctxbar(m), card(m)];
    if (m.state !== 'empty') {
      if (m.attention.length) {
        kids.push(heading('warning', 'tc k-replace', 'Needs a look', m.attention.length));
        m.attention.forEach((it) => kids.push(box(it, true)));
      }
      if (m.updates.length) {
        kids.push(heading('edit', '', 'Updates', m.updates.length));
        const shown = showAllUpdates ? m.updates : m.updates.slice(0, MAX_UPDATES);
        shown.forEach((it) => kids.push(box(it, false)));
        if (m.updates.length > shown.length) {
          kids.push(h('button', { class: 'pl-more', onclick: () => { showAllUpdates = true; render(); } }, `+ ${m.updates.length - shown.length} more`));
        }
      }
      if (m.creates.length) {
        kids.push(heading('add', '', 'Creates', m.creates.length));
        m.creates.forEach((it) => kids.push(row(it)));
      }
      if (m.reads.length) {
        kids.push(heading('eye', '', 'Reads', m.reads.length));
        m.reads.forEach((it) => kids.push(row(it)));
      }
      if (m.unchanged) kids.push(h('div', { class: 'pl-ck' }, h('span', { class: 'name', text: `${m.unchanged} unchanged` })));
    }
    const y = window.scrollY;
    app.replaceChildren(...kids);
    window.scrollTo(0, y);
  }

  function reveal(address) {
    const el = [...document.querySelectorAll('[data-address]')].find((e) => e.getAttribute('data-address') === address);
    if (!el) {
      if (!showAllUpdates) { showAllUpdates = true; render(); return reveal(address); }
      return;
    }
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'model') {
      if (!model || msg.model.sub.split(' · ')[0] !== model.sub.split(' · ')[0] || msg.model.title !== model.title) showAllUpdates = false;
      model = msg.model;
      render();
    } else if (msg.type === 'reveal') {
      reveal(msg.address);
    }
  });
  post('ready');
})();
