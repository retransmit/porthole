import crypto from 'node:crypto';

export const COOKIE_NAME = 'porthole';

/**
 * What each role is allowed to do. This table is the single source of truth and is
 * consulted on the server for every inbound action. The browser hides controls a role
 * lacks as a courtesy, never as a control.
 */
const CAPABILITIES = {
  view: new Set(['view']),
  control: new Set(['view', 'input', 'resize', 'helm', 'files']),
  admin: new Set(['view', 'input', 'resize', 'helm', 'files', 'create', 'kill', 'invite', 'admin']),
};

export const ROLES = Object.keys(CAPABILITIES);

/**
 * Actions an individual invite may be granted beyond its role.
 *
 * Deliberately a whitelist of one. Starting a session means running a process on the
 * host, which is the difference between lending someone a view of your work and lending
 * them your machine. Your own phone should be able to; a friend's control link should
 * not. Anything outside this set is ignored even if it somehow appears on an invite.
 */
const GRANTABLE = new Set(['create']);

/** A grant is meaningless to a role that cannot even type. */
const GRANTABLE_ROLES = new Set(['control', 'admin']);

/**
 * @param {string} role
 * @param {string} action
 * @param {{viewersCanBrowseFiles?: boolean}} [flags] server-side config toggles
 * @param {string[]} [grants] extra actions this specific invite was given
 */
export function can(role, action, flags = {}, grants = []) {
  const caps = CAPABILITIES[role];
  if (!caps) return false;
  if (caps.has(action)) return true;

  if (
    GRANTABLE.has(action) &&
    GRANTABLE_ROLES.has(role) &&
    Array.isArray(grants) &&
    grants.includes(action)
  ) {
    return true;
  }
  // The one capability an admin can hand to viewers. Sharing a terminal and sharing a
  // source tree are separate decisions, so this is opt-in rather than implied.
  if (action === 'files' && role === 'view' && flags.viewersCanBrowseFiles === true) return true;
  return false;
}

/**
 * Constant-time string comparison. Returns false instead of throwing on length
 * mismatch or non-string input. Token lengths are fixed and public, so leaking
 * length through an early return costs nothing.
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || header.length === 0) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Credentials are accepted three ways, in descending order of preference:
 *   1. Authorization: Bearer <token>   preferred by non-browser clients
 *   2. the porthole cookie             set once, after a link is first opened
 *   3. ?t=<token> in the URL           how a shared link arrives the first time
 */
export function extractToken(req) {
  const headers = req?.headers ?? {};

  const auth = headers.authorization;
  if (typeof auth === 'string') {
    const match = /^bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }

  const cookies = parseCookies(headers.cookie);
  if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];

  if (typeof req?.url === 'string') {
    const q = req.url.indexOf('?');
    if (q !== -1) {
      const t = new URLSearchParams(req.url.slice(q + 1)).get('t');
      if (t) return t;
    }
  }

  return null;
}

/**
 * Decide whether a WebSocket handshake is allowed to proceed.
 *
 * WebSockets are not subject to CORS, and a browser attaches cookies to a handshake
 * regardless of which page opened it. SameSite=Lax helps, but it is scoped to the
 * registrable domain, and every machine on a tailnet shares one. A page served from
 * another tailnet host can therefore be same-site with the panel, so a viewer could
 * host a page, have the operator open it, and ride the operator's cookie into an admin
 * socket. Cookies alone are not proof that the user meant to connect.
 *
 * The rule:
 *   - Origin present  ->  it must match the host, or a host the operator allowed.
 *   - Origin absent   ->  only allowed with a bearer token. Native clients send no
 *                         Origin, and an attacker's page cannot set that header, so
 *                         this admits real API clients without admitting hijacks.
 *
 * @returns {{ok: boolean, reason: string|null}}
 */
export function checkHandshakeOrigin(req, extraHosts = []) {
  const headers = req?.headers ?? {};
  const origin = headers.origin;

  if (!origin) {
    const bearer = typeof headers.authorization === 'string' && /^bearer\s+\S/i.test(headers.authorization.trim());
    return bearer ? { ok: true, reason: null } : { ok: false, reason: 'no-origin' };
  }

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    // Covers the literal "null" origin from sandboxed frames and anything malformed.
    return { ok: false, reason: 'origin' };
  }
  if (!originHost) return { ok: false, reason: 'origin' };

  const allowed = new Set([headers.host, ...extraHosts].filter(Boolean));
  return allowed.has(originHost) ? { ok: true, reason: null } : { ok: false, reason: 'origin' };
}

/** Sliding-window failure counter, keyed by source address. */
export class RateLimiter {
  constructor({ limit = 10, windowMs = 60_000, now = () => Date.now() } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  fail(key) {
    const t = this.now();
    const rec = this.hits.get(key);
    if (!rec || t - rec.first > this.windowMs) {
      this.hits.set(key, { first: t, count: 1 });
    } else {
      rec.count += 1;
    }
  }

  succeed(key) {
    this.hits.delete(key);
  }

  blocked(key) {
    const rec = this.hits.get(key);
    if (!rec) return false;
    if (this.now() - rec.first > this.windowMs) {
      this.hits.delete(key);
      return false;
    }
    return rec.count >= this.limit;
  }
}
