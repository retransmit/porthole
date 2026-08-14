/* Porthole client. Speaks protocol v1: JSON control frames plus binary terminal output. */

const PROTOCOL_VERSION = 1;

const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'), rail: $('rail'), railToggle: $('railToggle'),
  host: $('host'), linkstate: $('linkstate'), crew: $('crew'),
  sessions: $('sessions'), sessionsEmpty: $('sessionsEmpty'),
  history: $('history'), historyEmpty: $('historyEmpty'),
  scope: $('scope'), scopeIdle: $('scopeIdle'), term: $('term'),
  attention: $('attention'), attentionText: $('attentionText'), attentionDismiss: $('attentionDismiss'),
  keys: $('keys'), helm: $('helm'), prompt: $('prompt'), send: $('send'),
  helmLock: $('helmLock'), filesOpen: $('filesOpen'), newSession: $('newSession'),
  sizeGauge: $('sizeGauge'), helmGauge: $('helmGauge'), roleGauge: $('roleGauge'),
  drawer: $('drawer'), drawerBody: $('drawerBody'), drawerClose: $('drawerClose'), crumbs: $('crumbs'),
  toasts: $('toasts'), newSheet: $('newSheet'), newForm: $('newForm'), newCwd: $('newCwd'), newLabel: $('newLabel'),
  fitToggle: $('fitToggle'),
  askSheet: $('askSheet'), askTitle: $('askTitle'), askBody: $('askBody'), askYes: $('askYes'),
};

const state = {
  ws: null,
  clientId: null,
  role: 'view',
  label: '',
  caps: {},
  sessions: [],
  history: [],
  current: null,
  ordinals: new Map(),   // ordinal -> sessionId
  decoders: new Map(),   // ordinal -> TextDecoder
  helmHolder: null,
  isTouch: window.matchMedia('(pointer: coarse)').matches,
  /**
   * Whether this client votes on the pty size.
   *
   * Desktops always do. A phone decides per session: alone on it, the phone sizes the
   * terminal to itself, because 161 columns scaled onto a 390px screen renders text
   * about four pixels tall and is useless. With a desktop also watching, the phone
   * stands down and scales instead, so arriving on a phone cannot squeeze someone
   * else's session down to forty columns. `fitOverride` lets the user force either way.
   */
  wantsResize: !window.matchMedia('(pointer: coarse)').matches,
  fitOverride: null,
  attentionOn: false,
  backoff: 500,
  drawerTab: 'files',
  fsPath: '',
};

/* ---------- terminal ---------- */

const term = new Terminal({
  allowProposedApi: true,
  cursorBlink: true,
  fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, ui-monospace, monospace",
  fontSize: 13,
  lineHeight: 1.15,
  scrollback: 8000,
  theme: {
    background: '#0a1013', foreground: '#d9e5e8', cursor: '#c9a227', cursorAccent: '#0a1013',
    selectionBackground: 'rgba(201,162,39,.28)',
    black: '#0d1418', red: '#e8563f', green: '#4fb286', yellow: '#c9a227',
    blue: '#5aa9d6', magenta: '#b98cd1', cyan: '#5fbfb3', white: '#d9e5e8',
    brightBlack: '#5b7178', brightRed: '#ff7a63', brightGreen: '#6fd0a4', brightYellow: '#e3bd44',
    brightBlue: '#7cc4ea', brightMagenta: '#d3a9e6', brightCyan: '#7fd8cc', brightWhite: '#f2f7f8',
  },
});

const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon.WebLinksAddon());
// Must match the server's mirror, or wrapping in a snapshot diverges from the live stream.
const unicode = new Unicode11Addon.Unicode11Addon();
term.loadAddon(unicode);
term.unicode.activeVersion = '11';

term.open(els.term);

try {
  term.loadAddon(new WebglAddon.WebglAddon());
} catch {
  // The DOM renderer is slower but always available.
}

term.onData((data) => send({ t: 'input', sessionId: state.current, data }));

/* ---------- transport ---------- */

function send(msg) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...msg }));
  }
}

function setLink(status) {
  els.linkstate.dataset.state = status;
  els.linkstate.textContent = status;
}

function connect() {
  setLink('connecting');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.onopen = () => {
    setLink('open');
    state.backoff = 500;
    send({ t: 'hello', client: { kind: state.wantsResize ? 'desktop' : 'touch', cols: term.cols, rows: term.rows, wantsResize: state.wantsResize } });
    if (state.current) attach(state.current);
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') return onControl(JSON.parse(ev.data));
    const bytes = new Uint8Array(ev.data);
    const ordinal = bytes[0];
    if (state.ordinals.get(ordinal) !== state.current) return;
    let decoder = state.decoders.get(ordinal);
    if (!decoder) {
      decoder = new TextDecoder('utf-8');
      state.decoders.set(ordinal, decoder);
    }
    term.write(decoder.decode(bytes.subarray(1), { stream: true }));
  };

  ws.onclose = () => {
    setLink('closed');
    state.backoff = Math.min(state.backoff * 1.7, 15000);
    setTimeout(connect, state.backoff);
  };

  ws.onerror = () => ws.close();
}

function onControl(msg) {
  switch (msg.t) {
    case 'welcome':
      state.clientId = msg.clientId;
      state.role = msg.role;
      state.label = msg.label;
      state.caps = msg.caps ?? {};
      els.roleGauge.textContent = `you are ${msg.label} (${msg.role})`;
      els.newSession.hidden = !state.caps.create;
      els.filesOpen.hidden = !state.caps.files;
      applyRole();
      renderSessions(msg.sessions);
      loadHistory();
      break;

    case 'sessions':
      renderSessions(msg.sessions);
      break;

    case 'attached':
      state.ordinals.set(msg.ordinal, msg.sessionId);
      state.decoders.delete(msg.ordinal);
      break;

    case 'snapshot':
      if (msg.sessionId !== state.current) break;
      term.reset();
      term.write(msg.data);
      applyGeometry(msg.cols, msg.rows);
      break;

    case 'sized':
      if (msg.sessionId !== state.current) break;
      applyGeometry(msg.cols, msg.rows);
      els.sizeGauge.textContent = `${msg.cols}x${msg.rows}${msg.by ? ` set by ${msg.by}` : ''}`;
      break;

    case 'presence':
      if (msg.sessionId !== state.current) break;
      renderCrew(msg);
      break;

    case 'attention':
      if (msg.sessionId === state.current) raiseAttention(msg.text);
      notify(msg.text, state.sessions.find((s) => s.id === msg.sessionId)?.label ?? '');
      break;

    case 'helm':
      state.helmHolder = msg.holder ?? null;
      updateHelm();
      if (msg.ok === false) toast(`Someone else has the helm`, 'warn');
      break;

    case 'denied':
      if (msg.reason === 'role') toast('You are watching this session, not steering it', 'warn');
      else if (msg.reason === 'helm') toast('Someone else has the helm right now', 'warn');
      else if (msg.reason === 'dead') toast('That session has stopped', 'warn');
      break;

    case 'exit':
      if (msg.sessionId === state.current) term.write(`\r\n\x1b[2m-- session exited (${msg.code}) --\x1b[0m\r\n`);
      break;

    case 'error':
      toast(msg.message ?? 'Something went wrong', 'warn');
      break;
  }
}

/* ---------- geometry ---------- */

/**
 * Desktops fit the terminal to their window and vote on the pty size. Touch clients
 * keep the full grid and scale it down, so the whole screen stays readable rather than
 * being cropped.
 */
function applyGeometry(cols, rows) {
  if (state.wantsResize) return;
  term.resize(cols, rows);
  requestAnimationFrame(scaleToFit);
}

function scaleToFit() {
  const screen = els.term.querySelector('.xterm-screen');
  if (!screen) return;
  const natural = screen.offsetWidth;
  if (!natural) return;
  const available = els.scope.clientWidth - 16;
  const scale = Math.min(1, available / natural);
  els.term.style.transformOrigin = 'top left';
  els.term.style.transform = scale < 1 ? `scale(${scale.toFixed(4)})` : '';
}

/**
 * Decide whether this client should vote on the pty size, and tell the server if the
 * answer changed. Only touch clients ever change their mind.
 */
function applySizePolicy(viewers) {
  if (!state.isTouch) return;

  const alone = (viewers ?? 1) <= 1;
  const want = state.fitOverride ?? alone;

  if (want !== state.wantsResize) {
    state.wantsResize = want;
    send({
      t: 'hello',
      client: { kind: 'touch', cols: term.cols, rows: term.rows, wantsResize: want },
    });
    refit();
  }

  els.fitToggle?.setAttribute('aria-pressed', String(want));
}

function refit() {
  if (!state.current) return;
  if (state.wantsResize) {
    try {
      fit.fit();
    } catch {
      return;
    }
    send({ t: 'resize', sessionId: state.current, cols: term.cols, rows: term.rows });
  } else {
    scaleToFit();
  }
}

let refitTimer;
new ResizeObserver(() => {
  clearTimeout(refitTimer);
  refitTimer = setTimeout(refit, 120);
}).observe(els.scope);

/* ---------- sessions ---------- */

function attach(sessionId) {
  if (state.current && state.current !== sessionId) send({ t: 'detach', sessionId: state.current });
  state.current = sessionId;
  state.decoders.clear();
  term.reset();
  els.scopeIdle.hidden = true;
  send({ t: 'attach', sessionId });
  clearAttention();
  renderSessions(state.sessions);
  els.rail.classList.remove('is-open');
  setTimeout(refit, 60);
  term.focus();
}

function renderSessions(sessions) {
  state.sessions = sessions ?? state.sessions;
  els.sessions.replaceChildren();
  els.sessionsEmpty.hidden = state.sessions.length > 0;

  for (const s of state.sessions) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = `slot${s.id === state.current ? ' is-on' : ''}${s.alive ? '' : ' is-dead'}`;

    const lamp = document.createElement('span');
    lamp.className = 'lamp';
    lamp.dataset.alive = String(s.alive);
    if (s.attention) lamp.dataset.attention = 'true';

    const name = document.createElement('span');
    name.className = 'slot-name';
    name.textContent = s.label;

    const sub = document.createElement('span');
    sub.className = 'slot-sub';
    sub.textContent = s.alive
      ? `${s.viewers} watching  ${s.cols}x${s.rows}`
      : `stopped (${s.exitCode ?? '?'})`;

    btn.append(lamp, name, sub);
    btn.onclick = () => attach(s.id);
    li.append(btn);
    els.sessions.append(li);
  }

  const live = state.sessions.find((s) => s.id === state.current);
  if (live) {
    els.sizeGauge.textContent = `${live.cols}x${live.rows}${live.sizedBy ? ` set by ${live.sizedBy}` : ''}`;
    state.helmHolder = live.helm;
    updateHelm();
    applySizePolicy(live.viewers);
  }
}

async function loadHistory() {
  try {
    const res = await fetch('/api/history?limit=40');
    const data = await res.json();
    state.history = data.sessions ?? [];
  } catch {
    state.history = [];
  }

  els.history.replaceChildren();
  const running = new Set(state.sessions.map((s) => s.id));
  const resumable = state.history.filter((h) => h.resumable && !running.has(h.sessionId));
  els.historyEmpty.hidden = resumable.length > 0;

  for (const h of resumable.slice(0, 25)) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'slot';
    btn.disabled = !state.caps.create;

    const lamp = document.createElement('span');
    lamp.className = 'lamp';
    lamp.dataset.alive = 'false';

    const name = document.createElement('span');
    name.className = 'slot-name';
    name.textContent = h.title;

    const sub = document.createElement('span');
    sub.className = 'slot-sub';
    const where = h.cwd?.split(/[\\/]/).pop() ?? '';
    // Say so up front, rather than only refusing once they have clicked.
    sub.textContent = h.likelyLive
      ? `open elsewhere  ${where}`
      : `${new Date(h.lastActivityAt).toLocaleDateString()}  ${where}`;
    if (h.likelyLive) lamp.dataset.alive = 'true';

    btn.append(lamp, name, sub);
    btn.onclick = () => resume(h);
    li.append(btn);
    els.history.append(li);
  }
}

async function resume(h, force = false) {
  toast(`Resuming ${h.title}`);
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: h.cwd, label: h.title.slice(0, 40), resumeId: h.sessionId, force }),
    });
    const data = await res.json();

    // The server refuses by default when the conversation looks like it is already
    // open somewhere else, because a second copy would write the same transcript.
    if (res.status === 409 && data.code === 'already-live') {
      const go = await ask(
        'Already open somewhere else',
        `"${h.title}" was written to moments ago, so something is probably still in it. ` +
          'Opening a second copy means two Claude sessions appending to the same transcript.',
        'Open it anyway',
      );
      if (go) return resume(h, true);
      return toast('Left it alone');
    }

    if (!res.ok) return toast(data.error ?? 'Could not resume', 'warn');
    attach(data.session.id);
    loadHistory();
  } catch (err) {
    toast(err.message, 'warn');
  }
}

/* ---------- crew and helm ---------- */

function renderCrew(presence) {
  els.crew.replaceChildren();
  for (const v of presence.viewers ?? []) {
    const chip = document.createElement('span');
    chip.className = 'crew-chip';
    chip.dataset.role = v.role;
    chip.dataset.helm = String(presence.helm === v.id);
    chip.textContent = v.label + (v.id === state.clientId ? ' (you)' : '');
    els.crew.append(chip);
  }
  state.helmHolder = presence.helm;
  updateHelm();
  applySizePolicy(presence.viewers?.length);
}

function updateHelm() {
  const mine = state.helmHolder && state.helmHolder === state.clientId;
  els.helmLock.setAttribute('aria-pressed', String(Boolean(mine)));
  els.helmLock.textContent = mine ? 'Release the helm' : 'Take the helm';
  els.helmGauge.textContent = state.helmHolder
    ? (mine ? 'you have the helm' : 'someone else has the helm')
    : 'helm is open';
}

function applyRole() {
  const canType = state.role !== 'view';
  els.prompt.disabled = !canType;
  els.send.disabled = !canType;
  els.helmLock.hidden = !canType;
  els.prompt.placeholder = canType ? 'Type a prompt, then send' : 'You are watching this session';
  term.options.cursorBlink = canType;
}

/* ---------- attention ---------- */

let titleTimer = null;

function raiseAttention(text) {
  state.attentionOn = true;
  els.attention.hidden = false;
  els.attentionText.textContent = text;
  els.scope.dataset.attention = 'true';

  if (document.hidden) {
    let on = false;
    clearInterval(titleTimer);
    titleTimer = setInterval(() => {
      document.title = (on = !on) ? 'Claude needs you' : 'Porthole';
    }, 900);
  }
  chime();
}

function clearAttention() {
  state.attentionOn = false;
  els.attention.hidden = true;
  delete els.scope.dataset.attention;
  clearInterval(titleTimer);
  document.title = 'Porthole';
  if (state.current) send({ t: 'clearAttention', sessionId: state.current });
}

/** Generated rather than shipped as an asset, so there is no file to fetch or cache. */
function chime() {
  try {
    const ctx = new (window.AudioContext ?? window.webkitAudioContext)();
    const now = ctx.currentTime;
    for (const [i, freq] of [880, 1320].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.09, now + i * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.24);
    }
    setTimeout(() => ctx.close(), 900);
  } catch {
    // Audio needs a prior gesture in some browsers. The banner still shows.
  }
}

function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, tag: 'porthole', icon: '/icon.svg' });
  } catch {
    // Some browsers only allow notifications from a service worker.
  }
}

/* ---------- files and changes ---------- */

function openDrawer(tab) {
  state.drawerTab = tab ?? state.drawerTab;
  els.drawer.hidden = false;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('is-on', t.dataset.tab === state.drawerTab);
  state.drawerTab === 'files' ? loadFiles(state.fsPath) : loadDiff();
}

async function loadFiles(rel) {
  state.fsPath = rel;
  els.crumbs.hidden = false;
  els.drawerBody.textContent = 'Loadingâ€¦';

  const res = await fetch(`/api/fs/list?session=${state.current}&path=${encodeURIComponent(rel)}`);
  const data = await res.json();
  if (!res.ok) return (els.drawerBody.textContent = data.error);

  renderCrumbs(rel);
  els.drawerBody.replaceChildren();

  if (rel) {
    els.drawerBody.append(row('..', 'dir', null, () => loadFiles(rel.split('/').slice(0, -1).join('/'))));
  }
  for (const e of data.entries) {
    const next = rel ? `${rel}/${e.name}` : e.name;
    els.drawerBody.append(
      row(e.name, e.type, e.size, () => (e.type === 'dir' ? loadFiles(next) : openFile(next))),
    );
  }
}

function row(name, type, size, onClick) {
  const btn = document.createElement('button');
  btn.className = 'row';
  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = type === 'dir' ? '/' : '.';
  const label = document.createElement('span');
  label.className = 'name';
  label.textContent = name;
  btn.append(kind, label);
  if (size != null) {
    const s = document.createElement('span');
    s.className = 'size';
    s.textContent = size > 1024 ? `${Math.round(size / 1024)}K` : `${size}B`;
    btn.append(s);
  }
  btn.onclick = onClick;
  return btn;
}

function renderCrumbs(rel) {
  els.crumbs.replaceChildren();
  const root = document.createElement('button');
  root.textContent = 'root';
  root.onclick = () => loadFiles('');
  els.crumbs.append(root);
  let acc = '';
  for (const part of rel.split('/').filter(Boolean)) {
    acc = acc ? `${acc}/${part}` : part;
    const sep = document.createElement('span');
    sep.textContent = '/';
    const b = document.createElement('button');
    b.textContent = part;
    const target = acc;
    b.onclick = () => loadFiles(target);
    els.crumbs.append(sep, b);
  }
}

async function openFile(rel) {
  const res = await fetch(`/api/fs/read?session=${state.current}&path=${encodeURIComponent(rel)}`);
  const data = await res.json();
  els.drawerBody.replaceChildren();
  renderCrumbs(rel);
  const pre = document.createElement('pre');
  pre.className = 'viewer';
  pre.textContent = data.binary ? '(binary file)' : data.text + (data.truncated ? '\n\nâ€¦ truncated' : '');
  els.drawerBody.append(pre);
}

async function loadDiff() {
  els.crumbs.hidden = true;
  els.drawerBody.textContent = 'Loadingâ€¦';
  const res = await fetch(`/api/git/diff?session=${state.current}`);
  const data = await res.json();
  els.drawerBody.replaceChildren();

  if (!data.repo) return (els.drawerBody.textContent = 'This folder is not a git repository.');
  if (!data.diff.trim()) return (els.drawerBody.textContent = 'No uncommitted changes.');

  for (const line of data.diff.split('\n')) {
    const span = document.createElement('span');
    span.className = 'diff-line';
    span.dataset.k = line.startsWith('+') ? '+' : line.startsWith('-') ? '-' : line.startsWith('@@') ? '@' : 'h';
    span.textContent = line || ' ';
    els.drawerBody.append(span);
  }
}

/* ---------- chrome ---------- */

/**
 * A confirmation the page owns. Deliberately not window.confirm, which blocks the
 * whole page and stalls anything driving the browser.
 */
function ask(title, body, confirmLabel = 'Continue') {
  return new Promise((resolve) => {
    els.askTitle.textContent = title;
    els.askBody.textContent = body;
    els.askYes.textContent = confirmLabel;
    els.askSheet.addEventListener('close', () => resolve(els.askSheet.returnValue === 'yes'), { once: true });
    els.askSheet.showModal();
  });
}

function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.kind = kind;
  el.textContent = message;
  els.toasts.append(el);
  setTimeout(() => el.remove(), 3600);
}

/** HTML attributes carry escapes literally, so turn "\x1b[A" into the real bytes. */
const unescapeKey = (raw) =>
  raw.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
     .replace(/\\t/g, '\t')
     .replace(/\\r/g, '\r')
     .replace(/\\n/g, '\n');

for (const btn of els.keys.querySelectorAll('button[data-key]')) {
  btn.onclick = () => {
    send({ t: 'input', sessionId: state.current, data: unescapeKey(btn.dataset.key) });
    term.focus();
  };
}

els.fitToggle.onclick = () => {
  state.fitOverride = !state.wantsResize;
  applySizePolicy(state.sessions.find((s) => s.id === state.current)?.viewers);
  toast(state.fitOverride ? 'Sizing the session to this screen' : 'Showing the full screen, scaled');
};

els.helm.onsubmit = (e) => {
  e.preventDefault();
  const value = els.prompt.value;
  if (!value.trim() || !state.current) return;
  send({ t: 'input', sessionId: state.current, data: `${value}\r` });
  els.prompt.value = '';
  els.prompt.style.height = 'auto';
};

els.prompt.addEventListener('input', () => {
  els.prompt.style.height = 'auto';
  els.prompt.style.height = `${Math.min(els.prompt.scrollHeight, 144)}px`;
});

els.prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    els.helm.requestSubmit();
  }
});

els.helmLock.onclick = () => {
  const mine = state.helmHolder === state.clientId;
  send({ t: mine ? 'releaseHelm' : 'claimHelm', sessionId: state.current });
};

els.attentionDismiss.onclick = clearAttention;
els.railToggle.onclick = () => {
  const open = els.rail.classList.toggle('is-open');
  els.railToggle.setAttribute('aria-expanded', String(open));
};
els.filesOpen.onclick = () => openDrawer('files');
els.drawerClose.onclick = () => (els.drawer.hidden = true);
for (const t of document.querySelectorAll('.tab')) t.onclick = () => openDrawer(t.dataset.tab);

els.newSession.onclick = () => els.newSheet.showModal();
els.newForm.onsubmit = async (e) => {
  if (e.submitter?.value !== 'start') return;
  const cwd = els.newCwd.value.trim();
  const label = els.newLabel.value.trim();
  if (!cwd) return;
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd, label }),
    });
    const data = await res.json();
    if (!res.ok) return toast(data.error ?? 'Could not start it', 'warn');
    attach(data.session.id);
  } catch (err) {
    toast(err.message, 'warn');
  }
};

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    clearInterval(titleTimer);
    document.title = 'Porthole';
  }
});

/* Notifications and push need a secure context, which `tailscale serve` provides. */
async function setUpPush() {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission !== 'granted') return;

    const { key } = await (await fetch('/api/push/key')).json();
    if (!key) return;

    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64(key) }));

    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: sub }),
    });
  } catch {
    // Push is a bonus tier. The in-page banner works regardless.
  }
}

function urlBase64(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

setInterval(() => send({ t: 'ping' }), 30000);

// Exposed deliberately. The WebGL renderer paints to a canvas, so the terminal's
// contents are not in the DOM and there is otherwise no way to inspect what is on
// screen from the console or from a test harness.
window.__porthole = { term, state, send };

els.host.textContent = location.host;
connect();
document.addEventListener('pointerdown', setUpPush, { once: true });
