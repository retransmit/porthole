import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

import { can, checkHandshakeOrigin, extractToken } from './auth.js';
import { reloadIfChanged, resolveToken } from './config.js';
import { normaliseRemoteAddress, tailscaleWhois } from './net.js';

export const PROTOCOL_VERSION = 1;

const MAX_MESSAGE_BYTES = 1024 * 1024;

/**
 * The whole client contract lives here: a JSON control channel plus binary frames for
 * terminal output. It is deliberately explicit and versioned, because a native mobile
 * client is a stated goal and should be additive rather than a rewrite.
 *
 * Binary frames are `[ordinal, ...utf8 bytes]`. The ordinal is a small per-connection
 * number handed out at attach time, which avoids repeating a 36 character session uuid
 * on every chunk of a hot stream.
 */
export function attachWebSocket({
  server,
  config,
  manager,
  stateDir = null,
  log = () => {},
  flags = () => ({}),
  allowedOrigins = [],
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const clients = new Set();

  server.on('upgrade', (req, socket, head) => {
    // Checked before the credential, because a hijacked handshake carries a perfectly
    // valid cookie. See checkHandshakeOrigin for why a cookie is not proof of intent.
    const origin = checkHandshakeOrigin(req, allowedOrigins);
    if (!origin.ok) {
      log(`refused websocket from origin ${req.headers.origin ?? '(none)'}: ${origin.reason}`);
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // A phone that just paired holds a token this process has never seen.
    if (stateDir) reloadIfChanged(stateDir, config);

    const token = extractToken(req);
    const identity = token ? resolveToken(config, token) : null;

    if (!identity) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, identity));
  });

  wss.on('connection', (ws, req, identity) => {
    const peer = normaliseRemoteAddress(req.socket.remoteAddress) ?? 'unknown';

    const client = {
      id: crypto.randomUUID(),
      label: identity.label,
      role: identity.role,
      cols: 120,
      rows: 30,
      // Desktops drive the pty size. Phones say so in `hello` and are excluded, so a
      // phone joining cannot squeeze everyone else down to its own width.
      wantsResize: true,
      ordinals: new Map(),
      nextOrdinal: 0,

      send(message) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
      },

      sendBinary(sessionId, chunk) {
        if (ws.readyState !== ws.OPEN) return;
        const ordinal = client.ordinals.get(sessionId);
        if (ordinal === undefined) return;
        const payload = Buffer.from(chunk, 'utf8');
        const frame = Buffer.allocUnsafe(payload.length + 1);
        frame[0] = ordinal;
        payload.copy(frame, 1);
        ws.send(frame);
      },
    };

    clients.add(client);

    // Identify the tailnet peer for the audit log, but never await before the message
    // listener below is attached. A client that sends `hello` the instant the socket
    // opens, which is exactly what the browser does, would otherwise have that message
    // arrive during the await and be dropped on the floor with no listener to catch it.
    tailscaleWhois(peer).then((who) => {
      log(`+ ${client.label} (${identity.role}) from ${peer}${who?.login ? ` as ${who.login}` : ''}`);
    });

    client.send({
      t: 'welcome',
      v: PROTOCOL_VERSION,
      clientId: client.id,
      role: identity.role,
      label: identity.label,
      peer,
      sessions: manager.list(),
      caps: {
        files: can(identity.role, 'files', flags(), identity.grants),
        create: can(identity.role, 'create', flags(), identity.grants),
        invite: can(identity.role, 'invite', flags(), identity.grants),
      },
    });

    const attach = async (sessionId) => {
      const rec = manager.get(sessionId);
      if (!rec) return client.send({ t: 'error', v: PROTOCOL_VERSION, code: 'no-session', message: sessionId });

      if (!client.ordinals.has(sessionId)) {
        if (client.nextOrdinal > 255) {
          return client.send({ t: 'error', v: PROTOCOL_VERSION, code: 'too-many', message: 'reload to attach more sessions' });
        }
        client.ordinals.set(sessionId, client.nextOrdinal++);
      }

      client.send({ t: 'attached', v: PROTOCOL_VERSION, sessionId, ordinal: client.ordinals.get(sessionId) });
      manager.attach(sessionId, client);

      const snap = await manager.snapshotFor(sessionId);
      if (snap) client.send({ t: 'snapshot', v: PROTOCOL_VERSION, ...snap });

      client.send({ t: 'presence', v: PROTOCOL_VERSION, ...manager.presence(sessionId) });
    };

    ws.on('message', async (raw, isBinary) => {
      if (isBinary) return;

      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return client.send({ t: 'error', v: PROTOCOL_VERSION, code: 'bad-json', message: 'could not parse message' });
      }

      if (msg.v && msg.v !== PROTOCOL_VERSION) {
        return client.send({
          t: 'error',
          v: PROTOCOL_VERSION,
          code: 'version',
          message: `this server speaks protocol v${PROTOCOL_VERSION}, the client asked for v${msg.v}`,
        });
      }

      switch (msg.t) {
        case 'hello': {
          const c = msg.client ?? {};
          if (Number.isFinite(c.cols)) client.cols = c.cols;
          if (Number.isFinite(c.rows)) client.rows = c.rows;
          if (typeof c.wantsResize === 'boolean') client.wantsResize = c.wantsResize;
          if (typeof c.kind === 'string') client.kind = c.kind;
          return;
        }

        case 'attach':
          return attach(msg.sessionId);

        case 'detach':
          manager.detach(msg.sessionId, client.id);
          return;

        case 'input': {
          const out = manager.input(msg.sessionId, client.id, msg.data ?? '');
          if (!out.ok) {
            client.send({ t: 'denied', v: PROTOCOL_VERSION, sessionId: msg.sessionId, reason: out.reason });
          }
          return;
        }

        case 'resize':
          manager.resize(msg.sessionId, client.id, msg.cols, msg.rows);
          return;

        case 'claimHelm':
          client.send({ t: 'helm', v: PROTOCOL_VERSION, sessionId: msg.sessionId, ...manager.claimHelm(msg.sessionId, client.id) });
          return;

        case 'releaseHelm':
          client.send({ t: 'helm', v: PROTOCOL_VERSION, sessionId: msg.sessionId, ...manager.releaseHelm(msg.sessionId, client.id) });
          return;

        case 'seizeHelm':
          client.send({ t: 'helm', v: PROTOCOL_VERSION, sessionId: msg.sessionId, ...manager.seizeHelm(msg.sessionId, client.id) });
          return;

        case 'clearAttention':
          manager.clearAttention(msg.sessionId);
          return;

        case 'ping':
          client.send({ t: 'pong', v: PROTOCOL_VERSION });
          return;

        default:
          client.send({ t: 'error', v: PROTOCOL_VERSION, code: 'unknown', message: `unknown message type: ${msg.t}` });
      }
    });

    ws.on('close', () => {
      clients.delete(client);
      manager.disconnectClient(client.id);
      log(`- ${client.label} disconnected`);
    });

    ws.on('error', (err) => log(`socket error for ${client.label}: ${err.message}`));
  });

  // The session list changes for reasons a single client did not cause, so it is
  // pushed to everyone rather than polled.
  manager.on('sessions', (sessions) => {
    for (const client of clients) client.send({ t: 'sessions', v: PROTOCOL_VERSION, sessions });
  });

  return {
    wss,
    clients,
    close() {
      for (const ws of wss.clients) ws.close(1001, 'server shutting down');
      wss.close();
    },
  };
}
