// Plan Lens sidebar. Renders the ViewModel posted by the extension; plan data only ever goes into textContent.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const ICON = { create: 'add', update: 'edit', replace: 'sync', destroy: 'trash', forget: 'trash', read: 'eye' };
  // Terraform's own plan symbols.
  const SYM = { create: '+', update: '~', replace: '-/+', destroy: '-', forget: '-', read: '<=' };
  const MAX_UPDATES = 15;
  const state = Object.assign({ shut: {} }, vscode.getState() || {});
  let model;
  let showAllUpdates = false;
  /** Pick mode: the -target addresses being picked (null when not picking). */
  let pick = null;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === false || v === null) continue;
      if (k === 'class') el.className = v;
      // Through CSSOM: the CSP blocks style="" attributes, not element.style.
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
  const iconBtn = (name, title, type) => h('button', { class: 'icon', title, 'aria-label': title, onclick: typeof type === 'function' ? type : () => post(type) }, icon(name));
  // Same rule as src/model/targets.ts: a target selects itself, its instances and anything inside a module.
  const covers = (t, a) => a === t || a.startsWith(`${t}.`) || a.startsWith(`${t}[`);
  const pickedBy = (address) => pick && [...pick].find((t) => covers(t, address));
  /** Re-plan keeps a targeted plan's targets. */
  const replan = (m) => () => post('run', m.targets.length ? { targets: m.targets } : undefined);
  const startPick = (m) => { pick = new Set(m.targets); render(); };
  function togglePick(address) {
    const by = pickedBy(address);
    if (by && by !== address) return; // picked through its module: unpick the module instead
    if (by) pick.delete(address); else pick.add(address);
    render();
  }
  const pickable = (m) => m.canTarget && m.state === 'ready' && m.attention.length + m.updates.length + m.creates.length > 0;

  function header(m) {
    const running = m.state === 'running';
    const st = running ? h('span', { class: 'pl-state' }, icon('loading', 'spin'))
      : m.error ? h('span', { class: 'pl-state err', title: 'Last run failed' }, icon('error'))
      : m.state === 'ready' ? h('span', { class: 'pl-state ok', title: 'Plan ready' }, icon('check'))
      : null;
    const top = h('div', { class: 'top' },
      h('button', { class: `pl-env${m.env ? '' : ' none'}`, title: `Environment (from ${m.envFolder || 'the settings'}): click to change`, onclick: () => post('pickEnv') },
        icon('server-environment'), h('span', { class: 'lbl', text: m.env || 'Pick an environment' }), icon('chevron-down')),
      st,
      h('span', { class: 'grow' }),
      running ? iconBtn('debug-stop', m.applying ? 'Stop apply' : 'Stop plan', 'cancel') : iconBtn('refresh', m.loaded ? 'Run a plan instead' : 'Re-plan', replan(m)),
      pickable(m) && !pick ? iconBtn('target', 'Pick targets: plan and apply only some changes', () => startPick(m)) : null,
      iconBtn('folder-opened', 'Load a plan file', 'load'),
      m.state === 'ready' && !running ? iconBtn('close', 'Clear plan', 'clear') : null);
    const kids = [top];
    if (m.state === 'ready' || (running && m.sub)) {
      const counts = h('span', { class: 'counts' });
      for (const a of ['create', 'update', 'replace', 'destroy']) {
        if (m.counts[a]) counts.append(h('span', { class: `k-${a}`, title: `${m.counts[a]} to ${a}` }, h('b', { text: `${{ create: '+', update: '~', replace: '±', destroy: '−' }[a]}${m.counts[a]}` })));
      }
      if (!counts.childElementCount) counts.append(h('span', { text: 'no changes' }));
      // The folder name may be long; only it gets cut, the age and version stay visible.
      const [origin, ...rest] = m.sub.split(' · ');
      kids.push(h('div', { class: 'pl-meta' }, counts, h('span', { class: 'src ell', title: m.sub, text: origin }), rest.length ? h('span', { class: 'rest', text: '· ' + rest.join(' · ') }) : null));
    }
    if (m.state !== 'empty') {
      const bar = h('div', { class: `pl-split${running ? ' busy' : ''}${m.applying ? ' apply' : ''}`, role: running ? 'progressbar' : 'img', 'aria-label': running ? (m.applying ? 'Applying' : 'Planning') : 'Change mix' });
      if (running) bar.append(h('i'));
      else for (const b of m.bar) bar.append(h('i', { class: `k-${b.action}`, style: `width:${b.pct}%` }));
      kids.push(bar);
    }
    if (running) kids.push(h('button', { class: 'pl-tail', title: 'Open the full log', onclick: () => post('log') }, tailText(m.tail)));
    return h('header', { class: 'pl-head' }, kids);
  }

  const tailText = (lines) => (lines.length ? lines.join('\n') : 'Starting terraform…');
  /** A 'tail' message: new log lines while running; only the box changes. */
  function setTail(lines) {
    if (model) model.tail = lines;
    const box = document.querySelector('.pl-tail');
    if (box) { box.textContent = tailText(lines); box.scrollTop = box.scrollHeight; }
  }

  function section(key, label, n, iconName, iconCls, body) {
    const shut = !!state.shut[key];
    const toggle = () => { state.shut[key] = !shut; vscode.setState(state); render(); };
    return [
      h('div', { class: `gl-ck${shut ? ' shut' : ''}`, role: 'button', tabindex: '0', 'aria-expanded': String(!shut), onclick: toggle, onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle()) },
        h('span', { class: 'name' }, icon('chevron-down', 'chev'), iconName ? icon(iconName, iconCls) : null, label), h('span', { class: 'n', text: String(n) })),
      shut ? null : body(),
    ];
  }

  const open = (it) => (pick ? togglePick(it.address) : post(it.orphan ? 'copy' : 'open', { address: it.address }));
  const tip = (it) => {
    if (pick) {
      const by = pickedBy(it.address);
      return `${it.address}\n${by && by !== it.address ? `Picked through ${by}` : by ? 'Click to unpick' : 'Click to pick as a target'}`;
    }
    return `${it.address}${it.loc ? `\n${it.loc}` : ''}${it.orphan ? '\nNot in the code: click to copy the address' : ''}${it.pulled ? '\nNot targeted: terraform pulled it in as a dependency of a target' : ''}`;
  };
  /** Pick mode's leading check: picked, picked through a module, or not. */
  function check(address) {
    const by = pickedBy(address);
    return icon(by ? (by === address ? 'pass-filled' : 'pass') : 'circle-large-outline', `pk${by ? ' on' : ''}`);
  }
  const rowCls = (it) => `${pick ? ' picking' : ''}${pick && pickedBy(it.address) ? ' picked' : ''}${it.pulled ? ' pulled' : ''}`;

  /** A risky change: outlined, two lines (what, then why). */
  function orow(it) {
    const sub = h('div', { class: 'sub' }, h('span', { class: `gl-chip k-${it.action}` }, h('i', { class: 'dot' }), it.action));
    for (const s of it.sub) {
      const m = /^forced by (.*)$/.exec(s);
      if (m) sub.append(h('span', {}, 'forced by ', h('span', { class: 'mono hl', text: m[1] })));
      else if (s !== 'forget (state only)') sub.append(h('span', { text: s }));
      else sub.append(h('span', { text: 'state only' }));
    }
    if (it.pulled) sub.append(h('span', { class: 'pl-dep', text: 'pulled in' }));
    if (it.module) sub.append(h('span', { class: 'faint', text: it.module }));
    return h('button', { class: `gl-orow pl-orow k-${it.action}${rowCls(it)}`, title: tip(it), 'data-address': it.address, onclick: () => open(it) },
      pick ? check(it.address) : icon(ICON[it.action]),
      h('div', { class: 'grow' }, h('span', { class: 'name', text: it.title }), sub),
      pick ? null : icon(it.orphan ? 'copy' : 'go-to-file', 'go'));
  }

  /** Any other change: one dense row. */
  function row(it) {
    const detail = it.action === 'update' && it.sub[0] ? h('span', { class: 'dir mono', text: it.sub[0] })
      : h('span', { class: 'dir', text: it.module || '' });
    return h('button', { class: `pl-row k-${it.action}${rowCls(it)}`, title: tip(it), 'data-address': it.address, onclick: () => open(it) },
      pick ? check(it.address) : null,
      h('span', { class: 'name', text: it.title }), it.pulled ? h('span', { class: 'pl-dep', text: 'dep' }) : null, detail,
      it.loc ? h('span', { class: 'loc', text: it.loc }) : null,
      h('span', { class: 'sym', text: SYM[it.action] }));
  }

  /** A targeted plan's banner: what it is limited to, and the way back to a full plan. */
  function targeted(m) {
    const n = m.targets.length;
    return h('div', { class: 'pl-target', title: `terraform plan -target:\n${m.targets.join('\n')}` },
      icon('target'),
      h('span', { class: 'grow ell' }, h('b', { text: `Targeted · ${n} target${n > 1 ? 's' : ''}` }),
        m.pulled ? h('span', { class: 'faint', text: ` · ${m.pulled} pulled in` }) : null),
      m.canTarget ? h('button', { class: 'ghost', title: 'Change the targets', onclick: () => startPick(m) }, 'Edit') : null,
      m.canTarget ? h('button', { class: 'ghost', title: 'Plan everything again', onclick: () => post('run') }, 'Full plan') : null);
  }

  /** Pick mode: modules to target whole, above the changes. */
  function picking(m) {
    const kids = [h('div', { class: 'pl-line' }, icon('target'), h('span', { text: 'Pick what to plan. Terraform adds what the picks depend on; apply then covers only that.' }))];
    if (m.modules.length) {
      kids.push(...section('modules', 'Modules', m.modules.length, 'package', '', () => h('div', {}, m.modules.map((mod) =>
        h('button', { class: `pl-row pl-mod picking${pickedBy(mod.address) ? ' picked' : ''}`, title: tip({ address: mod.address }), 'data-address': mod.address, onclick: () => togglePick(mod.address) },
          check(mod.address), h('span', { class: 'name', text: mod.address }), h('span', { class: 'dir' }),
          h('span', { class: 'loc', text: `${mod.n} change${mod.n > 1 ? 's' : ''}` }))))));
    }
    return kids;
  }

  function changes(m) {
    const kids = [];
    if (pick) kids.push(...picking(m));
    else if (m.targets.length && m.state === 'ready') kids.push(targeted(m));
    if (m.attention.length) kids.push(...section('attention', 'Needs a look', m.attention.length, 'warning', 'warn', () => h('div', {}, m.attention.map(orow))));
    if (m.updates.length) {
      kids.push(...section('updates', 'Updates', m.updates.length, '', '', () => {
        const shown = showAllUpdates ? m.updates : m.updates.slice(0, MAX_UPDATES);
        return h('div', {}, shown.map(row),
          m.updates.length > shown.length ? h('button', { class: 'pl-more', onclick: () => { showAllUpdates = true; render(); } }, `Show ${m.updates.length - shown.length} more`) : null);
      }));
    }
    if (m.creates.length) kids.push(...section('creates', 'Creates', m.creates.length, '', '', () => h('div', {}, m.creates.map(row))));
    if (m.reads.length && !pick) kids.push(...section('reads', 'Reads', m.reads.length, '', '', () => h('div', {}, m.reads.map(row))));
    if (m.unchanged && !pick) kids.push(h('div', { class: 'pl-quiet', text: `${m.unchanged} resource${m.unchanged > 1 ? 's' : ''} unchanged` }));
    if (!kids.length && m.state === 'ready') {
      kids.push(h('div', { class: 'gl-empty done' }, icon('pass'), h('b', { text: 'No changes' }), h('span', { text: 'The infrastructure matches the configuration.' })));
    }
    return kids;
  }

  function empty(m) {
    const kids = [h('div', { class: 'gl-empty' }, icon('checklist'), h('b', { text: 'No plan yet' }),
      h('span', { text: m.envs.length ? 'Run a plan for an environment, or load a plan file.' : `No environments in ${m.envFolder || 'this workspace'}.` }),
      m.envs.length ? null : h('button', { class: 'primary', onclick: () => post('envFolder') }, icon('folder-library'), h('span', { text: 'Pick environments folder…' })))];
    if (m.envs.length) {
      kids.push(...section('envs', 'Environments', m.envs.length, '', '', () => h('div', {},
        m.envs.map((e) => h('button', { class: `gl-orow pl-env-row${e === m.env ? ' cur' : ''}`, title: `Plan ${e}`, onclick: () => post('run', { env: e }) },
          icon('server-environment'), h('span', { class: 'grow ell', text: e }), icon('play', 'play'))))));
    }
    kids.push(h('div', { class: 'pl-src' }, icon('folder'), h('span', { class: 'grow ell', title: m.envFolder, text: m.envFolder }),
      h('button', { class: 'ghost', title: 'Change the environments folder', onclick: () => post('envFolder') }, 'Change')));
    return kids;
  }

  function footer(m) {
    const env = m.env ? ` ${m.env}` : '';
    const btn = (cls, iconName, label, type) => h('button', { class: cls, title: label, onclick: typeof type === 'function' ? type : () => post(type) }, icon(iconName), h('span', { text: label }));
    let pair;
    if (pick) {
      const n = pick.size;
      const go = h('button', { class: 'primary', title: n ? `terraform plan with ${n} -target` : 'Pick at least one change or module', disabled: !n,
        onclick: () => { const targets = [...pick]; pick = null; post('run', { targets }); } }, icon('target'), h('span', { text: n ? `Plan ${n} target${n > 1 ? 's' : ''}` : 'Pick targets' }));
      pair = [btn('', 'close', 'Cancel', () => { pick = null; render(); }), go];
    } else if (m.state === 'running') pair = [btn('', 'debug-stop', m.applying ? 'Stop apply' : 'Cancel', 'cancel'), btn('', 'output', 'Log', 'log')];
    else if (m.state === 'empty') pair = [btn('primary', 'play', `Run plan${env}`, 'run'), btn('', 'folder-opened', 'Load file', 'load')];
    else if (m.canApply) pair = [btn('', 'refresh', 'Re-plan', replan(m)), btn('primary', 'rocket', m.targets.length ? 'Apply targeted' : `Apply${env}`, 'apply')];
    // Apply is off (planLens.allowApply): still shown, plain, so its click can say how to turn it on.
    else if (m.applyOff) pair = [btn('primary', 'refresh', 'Re-plan', replan(m)), btn('', 'rocket', m.targets.length ? 'Apply targeted…' : `Apply${env}…`, 'apply')];
    else if (m.loaded) pair = [btn('primary', 'folder-opened', 'Load another', 'load'), btn('', 'output', 'Log', 'log')];
    else pair = [btn('primary', 'refresh', `Re-plan${env}`, replan(m)), btn('', 'output', 'Log', 'log')];
    const note = m.state === 'running' ? (m.applying ? 'terraform apply is running — see the log' : 'terraform init, then plan…') : '';
    return h('footer', { class: 'pl-foot' }, h('div', { class: 'gl-btn-pair' }, pair), note ? h('div', { class: 'note', text: note }) : null);
  }

  function render() {
    const m = model;
    if (!m) return;
    const kids = [header(m)];
    if (m.error) kids.push(h('div', { class: 'pl-line err' }, icon('error'), h('span', { text: m.error })));
    kids.push(h('div', { class: 'pl-body' }, m.state === 'empty' ? empty(m) : changes(m)));
    kids.push(footer(m));
    const y = document.body.scrollTop;
    app.replaceChildren(...kids);
    document.body.scrollTop = y;
  }

  function reveal(address) {
    const el = [...document.querySelectorAll('[data-address]')].find((e) => e.getAttribute('data-address') === address);
    if (!el) {
      let again = false;
      if (!showAllUpdates) { showAllUpdates = true; again = true; }
      for (const k of Object.keys(state.shut)) if (state.shut[k]) { state.shut[k] = false; again = true; }
      if (again) { render(); return reveal(address); }
      return;
    }
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pick) { pick = null; render(); }
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'model') {
      if (!model || msg.model.sub.split(' · ')[0] !== model.sub.split(' · ')[0] || msg.model.title !== model.title) showAllUpdates = false;
      if (!pickable(msg.model)) pick = null;
      model = msg.model;
      render();
    } else if (msg.type === 'tail') {
      setTail(msg.lines);
    } else if (msg.type === 'reveal') {
      reveal(msg.address);
    }
  });
  post('ready');
})();
