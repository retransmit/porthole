import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COOKIE_NAME,
  RateLimiter,
  can,
  checkHandshakeOrigin,
  extractToken,
  serializeCookie,
  safeEqual,
} from './auth.js';
import { mintInvite, resolveToken, revokeInvite, saveConfig } from './config.js';
import { listSessions } from './history.js';
import { listDir, readTextFile } from './files.js';
import { gitDiff, gitStatus } from './git.js';
import { attentionFromHook } from './hooks.js';
import { normaliseRemoteAddress } from './net.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(here, '..', 'public');
const MODULES_DIR = path.resolve(here, '..', 'node_modules', '@xterm');

const MAX_BODY_BYTES = 256 * 1024;

/**
 * Browser bundles are served straight out of node_modules. That keeps the project
 * free of a build step entirely: install, then start.
 */
const VENDOR = {
  'xterm.js': path.join(MODULES_DIR, 'xterm', 'lib', 'xterm.js'),
  'xterm.css': path.join(MODULES_DIR, 'xterm', 'css', 'xterm.css'),
  'addon-fit.js': path.join(MODULES_DIR, 'addon-fit', 'lib', 'addon-fit.js'),
  'addon-web-links.js': path.join(MODULES_DIR, 'addon-web-links', 'lib', 'addon-web-links.js'),
  'addon-webgl.js': path.join(MODULES_DIR, 'addon-webgl', 'lib', 'addon-webgl.js'),
  'addon-unicode11.js': path.join(MODULES_DIR, 'addon-unicode11', 'lib', 'addon-unicode11.js'),
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
};

const text = (res, status, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('request body was not valid json');
  }
}

async function sendFile(res, file, { cache = false } = {}) {
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': cache ? 'public, max-age=3600' : 'no-store',
      'content-length': data.length,
    });
    res.end(data);
  } catch {
    text(res, 404, 'not found');
  }
}

const UNAUTHORISED_PAGE = `<!doctype html><meta charset="utf-8"><title>Porthole</title>
<style>body{background:#0b0e13;color:#c9d3e0;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;
display:grid;place-items:center;height:100vh;margin:0}div{max-width:34rem;padding:2rem;text-align:center}
code{background:#161b24;padding:.15rem .4rem;border-radius:4px;color:#8fd2ff}</style>
<div><h1>Porthole</h1><p>This link needs a valid token.</p>
<p>Run <code>npm run invite</code> on the host machine to mint one, or open the admin link
printed when the panel started.</p></div>`;

/**
 * @param {{config, stateDir, manager, notifier, hookToken, options, log}} deps
 */
export function createHttpServer({
  config,
  stateDir,
  manager,
  notifier,
  hookToken,
  options = {},
  log = () => {},
  allowedOrigins = [],
}) {
  const limiter = new RateLimiter({ limit: 12, windowMs: 60_000 });

  /**
   * Anything that changes state has to prove the request was meant for us.
   *
   * A cross-origin POST carrying content-type text/plain is a simple request, so it
   * skips the CORS preflight entirely, and the body is still valid JSON on arrival.
   * The attacker cannot read the reply, but the side effect lands, which for endpoints
   * that start shells is the part that matters.
   */
  const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const mutationAllowed = (req) => !MUTATING.has(req.method) || checkHandshakeOrigin(req, allowedOrigins).ok;

  const flags = () => ({ viewersCanBrowseFiles: config.viewersCanBrowseFiles === true });

  const sessionCwd = (id) => {
    const rec = manager.get(id);
    return rec?.cwd ?? null;
  };

  async function handleApi(req, res, url, identity) {
    const { role } = identity;
    const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const route = seg.slice(1).join('/');

    if (route === 'me') {
      return json(res, 200, {
        v: 1,
        role,
        label: identity.label,
        caps: {
          files: can(role, 'files', flags()),
          create: can(role, 'create'),
          invite: can(role, 'invite'),
          push: Boolean(notifier),
        },
        host: options.publicUrl ?? null,
      });
    }

    if (route === 'sessions' && req.method === 'GET') {
      return json(res, 200, { v: 1, sessions: manager.list() });
    }

    if (route === 'sessions' && req.method === 'POST') {
      if (!can(role, 'create')) return json(res, 403, { error: 'admin required' });
      const body = await readBody(req);

      // Resuming a conversation that is already open elsewhere starts a second process
      // appending to the same transcript. The manager can only see sessions it started
      // itself, so a session launched from a terminal would otherwise be resumed
      // straight over the top of itself.
      if (body.resumeId && !body.force) {
        const known = (await listSessions({ limit: 200 })).find((s) => s.sessionId === body.resumeId);
        if (known?.likelyLive) {
          return json(res, 409, {
            code: 'already-live',
            error: 'That conversation looks like it is already open somewhere else. Resuming would run a second copy writing the same transcript.',
          });
        }
      }

      try {
        const rec = await options.createSession({ ...body, by: identity.label });
        log(`${identity.label} created session ${rec.id} in ${rec.cwd}`);
        return json(res, 201, { v: 1, session: manager.list().find((s) => s.id === rec.id) });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    if (seg[1] === 'sessions' && seg[2] && req.method === 'DELETE') {
      if (!can(role, 'kill')) return json(res, 403, { error: 'admin required' });
      const ok = manager.kill(seg[2]);
      log(`${identity.label} killed session ${seg[2]}`);
      return json(res, ok ? 200 : 404, { ok });
    }

    if (route === 'history') {
      const limit = Number(url.searchParams.get('limit') ?? 60);
      return json(res, 200, { v: 1, sessions: await listSessions({ limit: Math.min(limit, 200) }) });
    }

    if (route === 'fs/list' || route === 'fs/read') {
      if (!can(role, 'files', flags())) return json(res, 403, { error: 'file access not permitted for this role' });
      const cwd = sessionCwd(url.searchParams.get('session'));
      if (!cwd) return json(res, 404, { error: 'unknown session' });
      const rel = url.searchParams.get('path') ?? '';
      try {
        const out = route === 'fs/list' ? await listDir(cwd, rel) : await readTextFile(cwd, rel);
        return json(res, 200, { v: 1, ...out });
      } catch (err) {
        return json(res, /denied/.test(err.message) ? 403 : 404, { error: err.message });
      }
    }

    if (route === 'git/status' || route === 'git/diff') {
      if (!can(role, 'files', flags())) return json(res, 403, { error: 'file access not permitted for this role' });
      const cwd = sessionCwd(url.searchParams.get('session'));
      if (!cwd) return json(res, 404, { error: 'unknown session' });
      try {
        const out =
          route === 'git/status'
            ? await gitStatus(cwd)
            : await gitDiff(cwd, {
                file: url.searchParams.get('file') || null,
                staged: url.searchParams.get('staged') === '1',
              });
        return json(res, 200, { v: 1, ...out });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    if (route === 'invites' && req.method === 'GET') {
      if (!can(role, 'invite')) return json(res, 403, { error: 'admin required' });
      return json(res, 200, {
        v: 1,
        invites: config.invites.map((i) => ({
          id: i.id,
          label: i.label,
          role: i.role,
          revoked: i.revoked,
          createdAt: i.createdAt,
          url: options.inviteUrl?.(i.token) ?? null,
        })),
      });
    }

    if (route === 'invites' && req.method === 'POST') {
      if (!can(role, 'invite')) return json(res, 403, { error: 'admin required' });
      const body = await readBody(req);
      try {
        const invite = mintInvite(config, { role: body.role ?? 'view', label: body.label ?? 'guest' });
        saveConfig(stateDir, config);
        log(`${identity.label} minted a ${invite.role} invite for ${invite.label}`);
        return json(res, 201, { v: 1, invite: { ...invite, url: options.inviteUrl?.(invite.token) ?? null } });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    if (seg[1] === 'invites' && seg[2] && req.method === 'DELETE') {
      if (!can(role, 'invite')) return json(res, 403, { error: 'admin required' });
      const ok = revokeInvite(config, seg[2]);
      if (ok) saveConfig(stateDir, config);
      log(`${identity.label} revoked invite ${seg[2]}`);
      return json(res, ok ? 200 : 404, { ok });
    }

    if (route === 'push/key') {
      return json(res, 200, { v: 1, key: notifier?.publicKey ?? null });
    }

    if (route === 'push/subscribe' && req.method === 'POST') {
      const body = await readBody(req);
      const ok = notifier?.subscribe(body.subscription, identity.label) ?? false;
      return json(res, ok ? 201 : 400, { ok });
    }

    return json(res, 404, { error: `no such endpoint: ${url.pathname}` });
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return text(res, 400, 'bad request');
    }

    const peer = normaliseRemoteAddress(req.socket.remoteAddress) ?? 'unknown';

    // Claude Code's hooks post here. They carry their own secret rather than a user
    // token, so that an attention event cannot be raised by anything that merely
    // reached the port.
    if (url.pathname === '/hook/attention' && req.method === 'POST') {
      const presented = extractToken(req);
      if (!presented || !safeEqual(presented, hookToken)) return json(res, 401, { error: 'bad hook token' });
      try {
        const body = await readBody(req);
        const attention = attentionFromHook(body.event);
        if (attention && body.sessionId) {
          manager.setAttention(body.sessionId, attention);
          await notifier?.send({
            title: attention.text,
            body: manager.get(body.sessionId)?.label ?? 'Claude session',
            sessionId: body.sessionId,
          });
        }
        return json(res, 202, { ok: true });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    if (limiter.blocked(peer)) return text(res, 429, 'too many failed attempts, wait a minute');

    if (!mutationAllowed(req)) {
      log(`refused ${req.method} ${url.pathname} from origin ${req.headers.origin ?? '(none)'}`);
      return json(res, 403, { error: 'this request did not come from the panel' });
    }

    const presented = extractToken(req);
    const identity = presented ? resolveToken(config, presented) : null;

    if (!identity) {
      if (presented) {
        limiter.fail(peer);
        log(`rejected token from ${peer}`);
      }
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(UNAUTHORISED_PAGE);
    }
    limiter.succeed(peer);

    // A token that arrived in the query string becomes a cookie, and the address bar
    // is cleaned up. Otherwise it lingers in history and leaks through Referer.
    if (url.searchParams.has('t')) {
      const secure = req.headers['x-forwarded-proto'] === 'https';
      res.writeHead(302, {
        'set-cookie': serializeCookie(COOKIE_NAME, presented, { maxAge: 60 * 60 * 24 * 30, secure }),
        location: url.pathname === '/' ? '/' : url.pathname,
        'cache-control': 'no-store',
      });
      return res.end();
    }

    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, identity);

      if (url.pathname.startsWith('/vendor/')) {
        const file = VENDOR[url.pathname.slice('/vendor/'.length)];
        return file ? await sendFile(res, file, { cache: true }) : text(res, 404, 'not found');
      }

      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const target = path.join(PUBLIC_DIR, name);
      // Static names come from our own directory listing, never from user input, but
      // the containment check costs nothing and removes the question entirely.
      if (!target.startsWith(PUBLIC_DIR) || !fs.existsSync(target)) return text(res, 404, 'not found');
      return await sendFile(res, target);
    } catch (err) {
      log(`error handling ${url.pathname}: ${err.stack ?? err.message}`);
      return json(res, 500, { error: 'internal error' });
    }
  });

  return server;
}
