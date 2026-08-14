import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

import { loadConfig, mintInvite, saveConfig } from '../src/config.js';
import { SessionManager } from '../src/session-manager.js';
import { createHttpServer } from '../src/http.js';
import { attachWebSocket } from '../src/ws.js';

/** Stands in for a pty so the test exercises the transport, not ConPTY. */
class FakeSession extends EventEmitter {
  constructor(opts) {
    super();
    Object.assign(this, opts);
    this.alive = true;
    this.exitCode = null;
  }
  start() { return this; }
  write() { return true; }
  resize(cols, rows) { this.cols = cols; this.rows = rows; return true; }
  async snapshot() { return `SCREEN-OF-${this.label}`; }
  destroy() { this.alive = false; this.emit('exit', 0); }
  dispose() { this.destroy(); }
}

let stateDir, config, manager, server, port, viewToken;

before(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-ws-'));
  config = loadConfig(stateDir);
  viewToken = mintInvite(config, { role: 'view', label: 'watcher' }).token;
  saveConfig(stateDir, config);

  manager = new SessionManager({ createSession: (o) => new FakeSession(o) });

  server = createHttpServer({
    config,
    stateDir,
    manager,
    notifier: null,
    hookToken: 'test-hook-token',
    options: { createSession: async (o) => manager.create({ ...o, cwd: o.cwd ?? 'C:/x', label: o.label ?? 'x' }) },
  });
  attachWebSocket({ server, config, manager, flags: () => ({}) });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  manager.killAll();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/** Opens a handshake with arbitrary headers, to exercise the hijack shapes directly. */
function openRaw(headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    ws.on('error', (err) => resolve({ accepted: false, error: err.message }));
    ws.on('open', () => {
      ws.close();
      resolve({ accepted: true });
    });
  });
}

function open(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${token}` } });
    const inbox = [];
    ws.on('message', (raw, isBinary) => { if (!isBinary) inbox.push(JSON.parse(raw.toString())); });
    ws.on('error', reject);
    ws.on('open', () => resolve({ ws, inbox, send: (m) => ws.send(JSON.stringify({ v: 1, ...m })) }));
  });
}

async function waitFor(conn, type, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = conn.inbox.find((m) => m.t === type);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe('websocket transport', () => {
  test('refuses an upgrade with no credential', async () => {
    const refused = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on('error', () => resolve(true));
      ws.on('open', () => { ws.close(); resolve(false); });
    });
    assert.equal(refused, true);
  });

  test('refuses a handshake from a foreign origin carrying a valid cookie', async () => {
    // The cross-site websocket hijack: a page elsewhere opens a socket, the browser
    // attaches the panel cookie by itself, and without an origin check that page
    // inherits whatever role the cookie holds.
    const out = await openRaw({
      origin: 'http://evil.example',
      cookie: `porthole=${config.adminToken}`,
    });
    assert.equal(out.accepted, false, 'a foreign origin must not get a socket');
    assert.match(out.error, /403/);
  });

  test('refuses a foreign origin even when it presents a valid bearer token', async () => {
    const out = await openRaw({
      origin: 'http://evil.example',
      authorization: `Bearer ${config.adminToken}`,
    });
    assert.equal(out.accepted, false);
  });

  test('refuses a cookie-only handshake that sends no origin at all', async () => {
    const out = await openRaw({ cookie: `porthole=${config.adminToken}` });
    assert.equal(out.accepted, false, 'an ambient cookie is not proof the user meant to connect');
  });

  test('accepts the panel own page, which sends a matching origin and the cookie', async () => {
    const out = await openRaw({
      origin: `http://127.0.0.1:${port}`,
      cookie: `porthole=${config.adminToken}`,
    });
    assert.equal(out.accepted, true);
  });

  test('accepts a native client that sends a bearer token and no origin', async () => {
    // A page cannot set the Authorization header on a websocket handshake, so this
    // admits real API and mobile clients without admitting a hijack.
    const out = await openRaw({ authorization: `Bearer ${config.adminToken}` });
    assert.equal(out.accepted, true);
  });

  test('handles messages sent immediately on open, before welcome arrives', async () => {
    // The browser sends `hello` from onopen without waiting. An await placed before the
    // message listener was registered used to drop those messages silently, which looked
    // like a session that simply never attached.
    const rec = manager.create({ cwd: 'C:/x', label: 'eager' });
    const conn = await open(config.adminToken);

    conn.send({ t: 'hello', client: { kind: 'desktop', cols: 90, rows: 25, wantsResize: true } });
    conn.send({ t: 'attach', sessionId: rec.id });

    const attached = await waitFor(conn, 'attached');
    assert.ok(attached, 'attach sent on open must not be dropped');

    const snapshot = await waitFor(conn, 'snapshot');
    assert.equal(snapshot.data, 'SCREEN-OF-eager');

    conn.ws.close();
    manager.kill(rec.id);
  });

  test('applies the size a client declared in its opening hello', async () => {
    const rec = manager.create({ cwd: 'C:/x', label: 'sizer' });
    const conn = await open(config.adminToken);

    conn.send({ t: 'hello', client: { kind: 'desktop', cols: 88, rows: 24, wantsResize: true } });
    conn.send({ t: 'attach', sessionId: rec.id });
    await waitFor(conn, 'snapshot');

    assert.equal(rec.session.cols, 88);
    assert.equal(rec.session.rows, 24);

    conn.ws.close();
    manager.kill(rec.id);
  });

  test('drops input from a view-only client without touching the session', async () => {
    const rec = manager.create({ cwd: 'C:/x', label: 'guarded' });
    let written = false;
    rec.session.write = () => { written = true; return true; };

    const conn = await open(viewToken);
    conn.send({ t: 'hello', client: { kind: 'desktop', cols: 90, rows: 25, wantsResize: true } });
    conn.send({ t: 'attach', sessionId: rec.id });
    await waitFor(conn, 'snapshot');

    conn.send({ t: 'input', sessionId: rec.id, data: 'rm -rf /' });
    const denied = await waitFor(conn, 'denied');

    assert.equal(denied.reason, 'role');
    assert.equal(written, false, 'nothing may reach the session');

    conn.ws.close();
    manager.kill(rec.id);
  });

  test('rejects a client speaking a different protocol version', async () => {
    const conn = await open(config.adminToken);
    conn.ws.send(JSON.stringify({ v: 99, t: 'attach', sessionId: 'whatever' }));
    const err = await waitFor(conn, 'error');
    assert.equal(err.code, 'version');
    conn.ws.close();
  });

  test('tells every connected client when the session list changes', async () => {
    const conn = await open(config.adminToken);
    await waitFor(conn, 'welcome');
    conn.inbox.length = 0;

    const rec = manager.create({ cwd: 'C:/x', label: 'broadcast' });
    const update = await waitFor(conn, 'sessions');

    assert.ok(update.sessions.some((s) => s.label === 'broadcast'));

    conn.ws.close();
    manager.kill(rec.id);
  });

  test('frees the helm when the holder disconnects', async () => {
    const rec = manager.create({ cwd: 'C:/x', label: 'helm' });

    const holder = await open(config.adminToken);
    holder.send({ t: 'hello', client: { cols: 90, rows: 25, wantsResize: true } });
    holder.send({ t: 'attach', sessionId: rec.id });
    await waitFor(holder, 'snapshot');
    holder.send({ t: 'claimHelm', sessionId: rec.id });
    assert.equal((await waitFor(holder, 'helm')).ok, true);

    holder.ws.close();
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(rec.helm.holder, null, 'a holder who vanishes must not lock the session');
    manager.kill(rec.id);
  });
});

describe('http api', () => {
  const call = (p, opts = {}) =>
    fetch(`http://127.0.0.1:${port}${p}`, {
      ...opts,
      headers: { authorization: `Bearer ${config.adminToken}`, ...(opts.headers ?? {}) },
    });

  test('serves the panel to a valid token', async () => {
    const res = await call('/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Porthole/);
  });

  test('refuses an unknown token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { authorization: 'Bearer nope' } });
    assert.equal(res.status, 401);
  });

  test('turns a query token into a cookie and redirects away from the url', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/?t=${config.adminToken}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('set-cookie'), /HttpOnly/);
    assert.equal(res.headers.get('location'), '/');
  });

  test('refuses session creation from a view-only token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${viewToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: 'C:/x' }),
    });
    assert.equal(res.status, 403);
  });

  test('refuses a state-changing post from a foreign origin', async () => {
    // A cross-origin POST with content-type text/plain is a simple request, so it
    // never triggers a preflight. The reply is opaque to the attacker, but a session
    // would still have been started.
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.adminToken}`,
        'content-type': 'text/plain',
        origin: 'http://evil.example',
      },
      body: JSON.stringify({ cwd: 'C:/x', label: 'csrf' }),
    });
    assert.equal(res.status, 403);
    assert.ok(!manager.list().some((s) => s.label === 'csrf'), 'no session may be created');
  });

  test('allows a state-changing post from the panel own origin', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.adminToken}`,
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ cwd: 'C:/x', label: 'same-origin' }),
    });
    assert.equal(res.status, 201);
    manager.kill((await res.json()).session.id);
  });

  test('still serves reads to a foreign origin, since cors keeps the reply unreadable', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { authorization: `Bearer ${config.adminToken}`, origin: 'http://evil.example' },
    });
    assert.equal(res.status, 200);
  });

  test('refuses a hook post carrying the wrong secret', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hook/attention`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'Notification' }),
    });
    assert.equal(res.status, 401);
  });

  test('accepts a hook post carrying the right secret', async () => {
    const rec = manager.create({ cwd: 'C:/x', label: 'hooked' });
    const res = await fetch(`http://127.0.0.1:${port}/hook/attention`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-hook-token', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: rec.id, event: 'Notification' }),
    });
    assert.equal(res.status, 202);
    assert.equal(manager.list().find((s) => s.id === rec.id).attention.kind, 'needs-input');
    manager.kill(rec.id);
  });
});
