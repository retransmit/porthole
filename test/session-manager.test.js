import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { SessionManager } from '../src/session-manager.js';

/**
 * A stand-in for the transport, not for logic under test. Session itself is covered
 * against a real ConPTY in session.test.js; here we care about who is allowed to do
 * what, and what each attached client ends up being told.
 */
class FakeSession extends EventEmitter {
  constructor(opts) {
    super();
    Object.assign(this, opts);
    this.alive = true;
    this.written = [];
    this.resizes = [];
    this.destroyed = false;
  }
  start() {
    return this;
  }
  write(d) {
    this.written.push(d);
    return true;
  }
  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.resizes.push([cols, rows]);
    return true;
  }
  async snapshot() {
    return `snapshot-of-${this.id}`;
  }
  /** Mirrors the real Session, which clears `alive` and records the code before emitting. */
  finish(code = 0) {
    this.alive = false;
    this.exitCode = code;
    this.emit('exit', code);
  }
  destroy() {
    this.destroyed = true;
    this.finish(0);
  }
  dispose() {
    this.destroy();
  }
}

const fakeClient = (id, over = {}) => ({
  id,
  label: id,
  role: 'control',
  cols: 100,
  rows: 30,
  wantsResize: true,
  /** JSON control messages. */
  sent: [],
  /** Terminal output frames, kept apart so counting one never counts the other. */
  data: [],
  send(msg) {
    this.sent.push(msg);
  },
  sendBinary(sessionId, chunk) {
    this.data.push(chunk);
  },
  ...over,
});

let mgr;

beforeEach(() => {
  mgr = new SessionManager({
    createSession: (opts) => new FakeSession(opts),
    claudePath: 'C:/fake/claude.exe',
  });
});

describe('SessionManager creation and listing', () => {
  test('creates a session with a generated uuid', () => {
    const rec = mgr.create({ cwd: 'C:/proj', label: 'demo' });
    assert.match(rec.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test('lists created sessions with their label and cwd', () => {
    mgr.create({ cwd: 'C:/proj', label: 'demo' });
    const list = mgr.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].label, 'demo');
    assert.equal(list[0].cwd, 'C:/proj');
  });

  test('reports zero viewers for a session nobody has attached to', () => {
    mgr.create({ cwd: 'C:/proj', label: 'demo' });
    assert.equal(mgr.list()[0].viewers, 0);
  });

  test('kill removes the session from the list', () => {
    const rec = mgr.create({ cwd: 'C:/proj', label: 'demo' });
    mgr.kill(rec.id);
    assert.equal(mgr.list().length, 0);
  });

  test('killing an unknown session reports failure rather than throwing', () => {
    assert.equal(mgr.kill('nope'), false);
  });
});

describe('SessionManager attach and presence', () => {
  test('counts attached viewers', () => {
    const rec = mgr.create({ cwd: 'C:/p', label: 'd' });
    mgr.attach(rec.id, fakeClient('a'));
    mgr.attach(rec.id, fakeClient('b'));
    assert.equal(mgr.list()[0].viewers, 2);
  });

  test('detach removes the client', () => {
    const rec = mgr.create({ cwd: 'C:/p', label: 'd' });
    const a = fakeClient('a');
    mgr.attach(rec.id, a);
    mgr.detach(rec.id, 'a');
    assert.equal(mgr.list()[0].viewers, 0);
  });

  test('presence lists who is attached and who holds the helm', () => {
    const rec = mgr.create({ cwd: 'C:/p', label: 'd' });
    mgr.attach(rec.id, fakeClient('a', { label: 'alice' }));
    mgr.claimHelm(rec.id, 'a');
    const p = mgr.presence(rec.id);
    assert.deepEqual(p.viewers.map((v) => v.label), ['alice']);
    assert.equal(p.helm, 'a');
  });

  test('fans terminal output out to every attached client', () => {
    const rec = mgr.create({ cwd: 'C:/p', label: 'd' });
    const a = fakeClient('a');
    const b = fakeClient('b');
    mgr.attach(rec.id, a);
    mgr.attach(rec.id, b);

    rec.session.emit('data', 'hello');

    assert.equal(a.data.length, 1);
    assert.equal(b.data.length, 1);
  });

  test('stops sending to a client once it detaches', () => {
    const rec = mgr.create({ cwd: 'C:/p', label: 'd' });
    const a = fakeClient('a');
    mgr.attach(rec.id, a);
    mgr.detach(rec.id, 'a');

    rec.session.emit('data', 'hello');

    assert.equal(a.data.length, 0);
  });
});

describe('SessionManager input gating', () => {
  test('accepts input from a control client while the helm is free', () => {
    const rec = mgr.create({ cwd: 'C:/p', label: 'd' });
    mgr.attach(rec.id, fakeClient('a'));
    assert.equal(mgr.input(rec.id, 'a', 'x').ok, true);
    assert.deepEqual(rec.session.written, ['x']);
  });

  test('refuses input from a view-only client', () => {
    const rec = mgr.create({ cwd: 'C:/p', label: 'd' });
    mgr.attach(rec.id, fakeClient('v', { role: 'view' }));

    const out = mgr.input(rec.id, 'v', 'x');

    assert.equal(out.ok, false);
    assert.equal(out.reason, 'role');
    assert.deepEqual(rec.session.written, [], 'nothing should reach the pty');
  });

  test('refuses input from a client that is not attached', () => {
    const rec = mgr.create({ cwd: 'C:/p', label: 'd' });
    assert.equal(mgr.input(rec.id, 'ghost', 'x').ok, false);
  });

  test('refuses input for an unknown session', () => {
    assert.equal(mgr.input('nope', 'a', 'x').ok, false);
  });

  test('refuses input from everyone except the helm holder', () => {
    const rec = mgr.create({ cwd: 'C:/p', label: 'd' });
    mgr.attach(rec.id, fakeClient('a'));
    mgr.attach(rec.id, fakeClient('b'));
    mgr.claimHelm(rec.id, 'a');

    assert.equal(mgr.input(rec.id, 'a', 'yes').ok, true);
    const denied = mgr.input(rec.id, 'b', 'no');
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'helm');
    assert.deepEqual(rec.session.written, ['yes']);
  });

  test('frees the helm when the holder disconnects entirely', () => {
    const rec = mgr.create({ cwd: 'C:/p', label: 'd' });
    mgr.attach(rec.id, fakeClient('a'));
    mgr.attach(rec.id, fakeClient('b'));
    mgr.claimHelm(rec.id, 'a');

    mgr.disconnectClient('a');

    assert.equal(mgr.input(rec.id, 'b', 'now-allowed').ok, true);
  });

  test('an admin can seize the helm from the holder', () => {
    const rec = mgr.create({ cwd: 'C:/p', label: 'd' });
    mgr.attach(rec.id, fakeClient('a'));
    mgr.attach(rec.id, fakeClient('admin', { role: 'admin' }));
    mgr.claimHelm(rec.id, 'a');

    assert.equal(mgr.seizeHelm(rec.id, 'admin').ok, true);
    assert.equal(mgr.input(rec.id, 'a', 'nope').ok, false);
    assert.equal(mgr.input(rec.id, 'admin', 'mine').ok, true);
  });

  test('a control client cannot seize the helm', () => {
    const rec = mgr.create({ cwd: 'C:/p', label: 'd' });
    mgr.attach(rec.id, fakeClient('a'));
    mgr.attach(rec.id, fakeClient('b'));
    mgr.claimHelm(rec.id, 'a');

    assert.equal(mgr.seizeHelm(rec.id, 'b').ok, false);
  });
});

describe('SessionManager size negotiation', () => {
  test('sizes the pty to the only attached client', () => {
    const rec = mgr.create({ cwd: 'C:/p', label: 'd' });
    mgr.attach(rec.id, fakeClient('a', { cols: 90, rows: 25 }));
    assert.deepEqual(rec.session.resizes.at(-1), [90, 25]);
  });

  test('shrinks to the smaller of two resizing clients', () => {
    const rec = mgr.create({ cwd: 'C:/p', label: 'd' });
    mgr.attach(rec.id, fakeClient('a', { cols: 160, rows: 50 }));
    mgr.attach(rec.id, fakeClient('b', { cols: 80, rows: 24 }));
    assert.deepEqual(rec.session.resizes.at(-1), [80, 24]);
  });

  test('a phone that opted out does not shrink the session', () => {
    const rec = mgr.create({ cwd: 'C:/p', label: 'd' });
    mgr.attach(rec.id, fakeClient('desk', { cols: 160, rows: 50 }));
    mgr.attach(rec.id, fakeClient('phone', { cols: 40, rows: 20, wantsResize: false }));
    assert.deepEqual(rec.session.resizes.at(-1), [160, 50]);
  });

  test('grows back when the smaller client leaves', () => {
    const rec = mgr.create({ cwd: 'C:/p', label: 'd' });
    mgr.attach(rec.id, fakeClient('a', { cols: 160, rows: 50 }));
    mgr.attach(rec.id, fakeClient('b', { cols: 80, rows: 24 }));
    mgr.detach(rec.id, 'b');
    assert.deepEqual(rec.session.resizes.at(-1), [160, 50]);
  });

  test('a view-only client still participates in sizing', () => {
    // A viewer whose window is smaller would otherwise see a truncated screen.
    const rec = mgr.create({ cwd: 'C:/p', label: 'd' });
    mgr.attach(rec.id, fakeClient('a', { cols: 160, rows: 50 }));
    mgr.attach(rec.id, fakeClient('v', { role: 'view', cols: 70, rows: 20 }));
    assert.deepEqual(rec.session.resizes.at(-1), [70, 20]);
  });

  test('a resize request from a view-only client is honoured for sizing only', () => {
    const rec = mgr.create({ cwd: 'C:/p', label: 'd' });
    mgr.attach(rec.id, fakeClient('v', { role: 'view', cols: 100, rows: 30 }));
    mgr.resize(rec.id, 'v', 60, 20);
    assert.deepEqual(rec.session.resizes.at(-1), [60, 20]);
  });
});

describe('SessionManager lifecycle events', () => {
  test('tells attached clients when the session exits', () => {
    const rec = mgr.create({ cwd: 'C:/p', label: 'd' });
    const a = fakeClient('a');
    mgr.attach(rec.id, a);

    rec.session.finish(0);

    const exitMsgs = a.sent.filter((m) => m && m.t === 'exit');
    assert.equal(exitMsgs.length, 1);
    assert.equal(exitMsgs[0].code, 0);
  });

  test('keeps an exited session listed so its final screen stays readable', () => {
    const rec = mgr.create({ cwd: 'C:/p', label: 'd' });
    rec.session.finish(0);
    const listed = mgr.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].alive, false);
  });

  test('remove drops an exited session for good', () => {
    const rec = mgr.create({ cwd: 'C:/p', label: 'd' });
    rec.session.finish(0);
    mgr.remove(rec.id);
    assert.equal(mgr.list().length, 0);
  });
});
