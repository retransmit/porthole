import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

import { Session } from './session.js';
import { Helm } from './helm.js';
import { negotiateSize } from './size.js';
import { can } from './auth.js';

/**
 * Owns every live session and every attached client.
 *
 * Two rules are enforced here rather than in the transport, so that no future caller
 * can route around them: what a role may do, and who currently holds the helm.
 */
export class SessionManager extends EventEmitter {
  constructor({
    createSession,
    defaultCols = 120,
    defaultRows = 30,
    flags = {},
  } = {}) {
    super();
    this.createSessionFn = createSession ?? ((opts) => new Session(opts));
    this.defaultCols = defaultCols;
    this.defaultRows = defaultRows;
    this.flags = flags;
    /** @type {Map<string, object>} */
    this.records = new Map();
  }

  /**
   * A resumed conversation keeps the id Claude Code already knows it by, so the panel
   * can always resume it again later. A fresh one gets a uuid we mint ourselves and
   * hand to `claude --session-id`, which is what makes resume reliable.
   */
  create({
    cwd,
    label,
    resumeId = null,
    file,
    args = [],
    env,
    cols = this.defaultCols,
    rows = this.defaultRows,
    meta = {},
  }) {
    const id = resumeId ?? crypto.randomUUID();

    const session = this.createSessionFn({ id, label, cwd, file, args, env, cols, rows, meta });

    const rec = {
      id,
      label,
      cwd,
      session,
      resumed: Boolean(resumeId),
      createdAt: Date.now(),
      clients: new Map(),
      helm: new Helm(),
      size: { cols, rows, by: null },
      attention: null,
    };

    session.on('data', (data) => {
      for (const client of rec.clients.values()) client.sendBinary(id, data);
    });

    session.on('exit', (code) => {
      this.broadcast(id, { t: 'exit', v: 1, sessionId: id, code });
      this.emit('sessions', this.list());
    });

    this.records.set(id, rec);
    session.start();
    this.emit('sessions', this.list());

    return rec;
  }

  get(id) {
    return this.records.get(id) ?? null;
  }

  list() {
    return [...this.records.values()].map((rec) => ({
      id: rec.id,
      label: rec.label,
      cwd: rec.cwd,
      alive: rec.session.alive,
      exitCode: rec.session.exitCode ?? null,
      viewers: rec.clients.size,
      helm: rec.helm.holder,
      cols: rec.size.cols,
      rows: rec.size.rows,
      sizedBy: rec.size.by,
      resumed: rec.resumed,
      createdAt: rec.createdAt,
      attention: rec.attention,
    }));
  }

  presence(id) {
    const rec = this.records.get(id);
    if (!rec) return null;
    return {
      sessionId: id,
      viewers: [...rec.clients.values()].map((c) => ({ id: c.id, label: c.label, role: c.role })),
      helm: rec.helm.holder,
    };
  }

  broadcast(id, message) {
    const rec = this.records.get(id);
    if (!rec) return;
    for (const client of rec.clients.values()) client.send(message);
  }

  attach(id, client) {
    const rec = this.records.get(id);
    if (!rec) return false;
    rec.clients.set(client.id, client);
    this.renegotiate(id);
    this.emit('presence', this.presence(id));
    this.emit('sessions', this.list());
    return true;
  }

  detach(id, clientId) {
    const rec = this.records.get(id);
    if (!rec) return false;
    const existed = rec.clients.delete(clientId);
    rec.helm.disconnect(clientId);
    this.renegotiate(id);
    this.emit('presence', this.presence(id));
    this.emit('sessions', this.list());
    return existed;
  }

  /** A client that drops off entirely leaves every session it was attached to. */
  disconnectClient(clientId) {
    for (const id of this.records.keys()) this.detach(id, clientId);
  }

  /** The current screen, for a client that has just joined. */
  async snapshotFor(id) {
    const rec = this.records.get(id);
    if (!rec) return null;
    return {
      sessionId: id,
      cols: rec.size.cols,
      rows: rec.size.rows,
      data: await rec.session.snapshot(),
    };
  }

  input(id, clientId, data) {
    const rec = this.records.get(id);
    if (!rec) return { ok: false, reason: 'gone' };

    const client = rec.clients.get(clientId);
    if (!client) return { ok: false, reason: 'detached' };

    if (!can(client.role, 'input', this.flags)) return { ok: false, reason: 'role' };
    if (!rec.helm.canType(clientId)) return { ok: false, reason: 'helm' };
    if (!rec.session.alive) return { ok: false, reason: 'dead' };

    rec.session.write(data);
    return { ok: true, label: client.label };
  }

  /**
   * Sizing is a rendering concern, not a privilege. A view-only client still gets a
   * vote, because otherwise it would sit there looking at a truncated screen.
   */
  resize(id, clientId, cols, rows) {
    const rec = this.records.get(id);
    if (!rec) return { ok: false, reason: 'gone' };

    const client = rec.clients.get(clientId);
    if (!client) return { ok: false, reason: 'detached' };

    client.cols = cols;
    client.rows = rows;
    this.renegotiate(id);
    return { ok: true };
  }

  renegotiate(id) {
    const rec = this.records.get(id);
    if (!rec) return null;

    const next = negotiateSize([...rec.clients.values()], rec.size);
    const changed = next.cols !== rec.size.cols || next.rows !== rec.size.rows || next.by !== rec.size.by;

    rec.size = next;
    rec.session.resize(next.cols, next.rows);

    if (changed) {
      this.broadcast(id, { t: 'sized', v: 1, sessionId: id, cols: next.cols, rows: next.rows, by: next.by });
      this.emit('sized', { sessionId: id, ...next });
    }
    return next;
  }

  claimHelm(id, clientId) {
    const rec = this.records.get(id);
    if (!rec) return { ok: false, reason: 'gone' };

    const client = rec.clients.get(clientId);
    if (!client) return { ok: false, reason: 'detached' };
    if (!can(client.role, 'helm', this.flags)) return { ok: false, reason: 'role' };

    const ok = rec.helm.claim(clientId);
    if (ok) this.announceHelm(id);
    return { ok, holder: rec.helm.holder };
  }

  releaseHelm(id, clientId) {
    const rec = this.records.get(id);
    if (!rec) return { ok: false, reason: 'gone' };
    const ok = rec.helm.release(clientId);
    if (ok) this.announceHelm(id);
    return { ok, holder: rec.helm.holder };
  }

  /** Admin override, so a session cannot stay locked by someone who wandered off. */
  seizeHelm(id, clientId) {
    const rec = this.records.get(id);
    if (!rec) return { ok: false, reason: 'gone' };

    const client = rec.clients.get(clientId);
    if (!client) return { ok: false, reason: 'detached' };
    if (!can(client.role, 'admin', this.flags)) return { ok: false, reason: 'role' };

    rec.helm.seize(clientId);
    this.announceHelm(id);
    return { ok: true, holder: rec.helm.holder };
  }

  announceHelm(id) {
    const presence = this.presence(id);
    this.broadcast(id, { t: 'presence', v: 1, ...presence });
    this.emit('presence', presence);
    this.emit('sessions', this.list());
  }

  setAttention(id, attention) {
    const rec = this.records.get(id);
    if (!rec) return false;
    rec.attention = attention;
    this.broadcast(id, { t: 'attention', v: 1, sessionId: id, ...attention });
    this.emit('sessions', this.list());
    return true;
  }

  clearAttention(id) {
    const rec = this.records.get(id);
    if (!rec) return false;
    rec.attention = null;
    this.emit('sessions', this.list());
    return true;
  }

  /** Explicit admin stop. The record goes away with it. */
  kill(id) {
    const rec = this.records.get(id);
    if (!rec) return false;
    rec.session.destroy();
    this.records.delete(id);
    this.emit('sessions', this.list());
    return true;
  }

  /**
   * Drop a session that has already exited. Exited sessions stay listed on purpose so
   * their final screen remains readable, which is usually where the error message is.
   */
  remove(id) {
    const rec = this.records.get(id);
    if (!rec) return false;
    rec.session.dispose();
    this.records.delete(id);
    this.emit('sessions', this.list());
    return true;
  }

  killAll() {
    for (const id of [...this.records.keys()]) this.kill(id);
  }
}
