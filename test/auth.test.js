import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  can,
  safeEqual,
  parseCookies,
  serializeCookie,
  extractToken,
  checkHandshakeOrigin,
  RateLimiter,
} from '../src/auth.js';

/**
 * WebSockets are not covered by CORS, and browsers attach cookies to a handshake from
 * any origin. Without this check a page on another tailnet host could open a socket to
 * the panel, ride the operator's cookie, and inherit their role.
 */
describe('checkHandshakeOrigin()', () => {
  const req = (headers) => ({ headers });

  test('accepts a handshake whose origin matches the host it was sent to', () => {
    const out = checkHandshakeOrigin(req({ origin: 'http://dexel.ts.net:7317', host: 'dexel.ts.net:7317' }));
    assert.equal(out.ok, true);
  });

  test('refuses a handshake from a different origin', () => {
    const out = checkHandshakeOrigin(req({ origin: 'http://evil.example:80', host: 'dexel.ts.net:7317' }));
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'origin');
  });

  test('refuses another host on the same tailnet, which lax cookies would not stop', () => {
    const out = checkHandshakeOrigin(req({ origin: 'http://friend.tailfe839d.ts.net', host: 'dexel.tailfe839d.ts.net:7317' }));
    assert.equal(out.ok, false);
  });

  test('treats a differing port as a different origin', () => {
    const out = checkHandshakeOrigin(req({ origin: 'http://dexel.ts.net:9999', host: 'dexel.ts.net:7317' }));
    assert.equal(out.ok, false);
  });

  test('refuses the opaque null origin used by sandboxed frames', () => {
    assert.equal(checkHandshakeOrigin(req({ origin: 'null', host: 'dexel.ts.net:7317' })).ok, false);
  });

  test('refuses an unparseable origin', () => {
    assert.equal(checkHandshakeOrigin(req({ origin: '://nonsense', host: 'dexel.ts.net:7317' })).ok, false);
  });

  test('accepts an extra host the operator allowed, for an https front end', () => {
    // `tailscale serve` terminates TLS and may not preserve the original Host header.
    const out = checkHandshakeOrigin(
      req({ origin: 'https://dexel.tailfe839d.ts.net', host: '127.0.0.1:7317' }),
      ['dexel.tailfe839d.ts.net'],
    );
    assert.equal(out.ok, true);
  });

  test('allows a non-browser client that presents a bearer token and no origin', () => {
    // Native clients send no Origin, and cannot be made to by an attacker's page.
    const out = checkHandshakeOrigin(req({ host: 'dexel.ts.net:7317', authorization: 'Bearer abc' }));
    assert.equal(out.ok, true);
  });

  test('refuses a handshake with no origin that relies on an ambient cookie', () => {
    // This is the shape a hijack takes if the browser omits Origin: no proof of intent,
    // just a cookie the browser attached on its own.
    const out = checkHandshakeOrigin(req({ host: 'dexel.ts.net:7317', cookie: 'porthole=abc' }));
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'no-origin');
  });

  test('a bearer token does not excuse a mismatched origin', () => {
    const out = checkHandshakeOrigin(
      req({ origin: 'http://evil.example', host: 'dexel.ts.net:7317', authorization: 'Bearer abc' }),
    );
    assert.equal(out.ok, false);
  });
});

describe('can()', () => {
  test('view role cannot send input', () => {
    assert.equal(can('view', 'input'), false);
  });

  test('control role can send input', () => {
    assert.equal(can('control', 'input'), true);
  });

  test('control role cannot kill sessions', () => {
    assert.equal(can('control', 'kill'), false);
  });

  test('admin role can kill sessions', () => {
    assert.equal(can('admin', 'kill'), true);
  });

  test('every role can view', () => {
    for (const role of ['view', 'control', 'admin']) {
      assert.equal(can(role, 'view'), true, `${role} should be able to view`);
    }
  });

  test('unknown role is denied everything', () => {
    assert.equal(can('superuser', 'view'), false);
    assert.equal(can(undefined, 'view'), false);
    assert.equal(can(null, 'input'), false);
  });

  test('unknown action is denied for every role', () => {
    assert.equal(can('admin', 'launch-missiles'), false);
  });

  test('view role cannot browse files by default', () => {
    assert.equal(can('view', 'files'), false);
  });

  test('view role can browse files when the admin opted viewers in', () => {
    assert.equal(can('view', 'files', { viewersCanBrowseFiles: true }), true);
  });

  test('the viewer file opt-in does not leak into input rights', () => {
    assert.equal(can('view', 'input', { viewersCanBrowseFiles: true }), false);
  });
});

describe('safeEqual()', () => {
  test('returns true for identical strings', () => {
    assert.equal(safeEqual('a'.repeat(64), 'a'.repeat(64)), true);
  });

  test('returns false for same-length different strings', () => {
    assert.equal(safeEqual('a'.repeat(64), 'b'.repeat(64)), false);
  });

  test('returns false rather than throwing when lengths differ', () => {
    assert.equal(safeEqual('short', 'a'.repeat(64)), false);
  });

  test('returns false for non-string input instead of throwing', () => {
    assert.equal(safeEqual(undefined, 'abc'), false);
    assert.equal(safeEqual('abc', null), false);
  });
});

describe('parseCookies()', () => {
  test('parses a single cookie', () => {
    assert.deepEqual(parseCookies('porthole=abc123'), { porthole: 'abc123' });
  });

  test('parses several cookies separated by semicolons', () => {
    assert.deepEqual(parseCookies('a=1; b=2; porthole=xyz'), { a: '1', b: '2', porthole: 'xyz' });
  });

  test('url-decodes values', () => {
    assert.deepEqual(parseCookies('k=a%20b'), { k: 'a b' });
  });

  test('returns an empty object for a missing or empty header', () => {
    assert.deepEqual(parseCookies(undefined), {});
    assert.deepEqual(parseCookies(''), {});
  });

  test('keeps values that themselves contain an equals sign', () => {
    assert.deepEqual(parseCookies('t=abc=def'), { t: 'abc=def' });
  });
});

describe('serializeCookie()', () => {
  test('marks the cookie HttpOnly so page scripts cannot read the token', () => {
    assert.match(serializeCookie('porthole', 'tok'), /HttpOnly/);
  });

  test('sets SameSite=Lax and a root path', () => {
    const out = serializeCookie('porthole', 'tok');
    assert.match(out, /SameSite=Lax/);
    assert.match(out, /Path=\//);
  });

  test('adds Secure only when asked', () => {
    assert.doesNotMatch(serializeCookie('porthole', 'tok'), /Secure/);
    assert.match(serializeCookie('porthole', 'tok', { secure: true }), /Secure/);
  });

  test('url-encodes the value', () => {
    assert.match(serializeCookie('k', 'a b'), /k=a%20b/);
  });
});

describe('extractToken()', () => {
  test('reads a bearer token from the Authorization header', () => {
    const req = { headers: { authorization: 'Bearer tok-from-header' } };
    assert.equal(extractToken(req), 'tok-from-header');
  });

  test('accepts a lowercase bearer scheme', () => {
    const req = { headers: { authorization: 'bearer tok' } };
    assert.equal(extractToken(req), 'tok');
  });

  test('falls back to the porthole cookie', () => {
    const req = { headers: { cookie: 'porthole=tok-from-cookie' } };
    assert.equal(extractToken(req), 'tok-from-cookie');
  });

  test('prefers the Authorization header over the cookie', () => {
    const req = {
      headers: { authorization: 'Bearer header-wins', cookie: 'porthole=cookie-loses' },
    };
    assert.equal(extractToken(req), 'header-wins');
  });

  test('reads the query token so a shared link works on first visit', () => {
    const req = { headers: {}, url: '/?t=tok-from-query' };
    assert.equal(extractToken(req), 'tok-from-query');
  });

  test('returns null when no credential is present', () => {
    assert.equal(extractToken({ headers: {} }), null);
  });
});

describe('RateLimiter', () => {
  test('allows attempts below the limit', () => {
    const rl = new RateLimiter({ limit: 3, windowMs: 1000 });
    rl.fail('1.2.3.4');
    rl.fail('1.2.3.4');
    assert.equal(rl.blocked('1.2.3.4'), false);
  });

  test('blocks once failures reach the limit', () => {
    const rl = new RateLimiter({ limit: 3, windowMs: 1000 });
    rl.fail('1.2.3.4');
    rl.fail('1.2.3.4');
    rl.fail('1.2.3.4');
    assert.equal(rl.blocked('1.2.3.4'), true);
  });

  test('tracks each source address separately', () => {
    const rl = new RateLimiter({ limit: 1, windowMs: 1000 });
    rl.fail('1.2.3.4');
    assert.equal(rl.blocked('1.2.3.4'), true);
    assert.equal(rl.blocked('5.6.7.8'), false);
  });

  test('forgets failures once the window has elapsed', () => {
    let now = 1000;
    const rl = new RateLimiter({ limit: 1, windowMs: 500, now: () => now });
    rl.fail('1.2.3.4');
    assert.equal(rl.blocked('1.2.3.4'), true);
    now = 1600;
    assert.equal(rl.blocked('1.2.3.4'), false);
  });

  test('a success clears the failure count', () => {
    const rl = new RateLimiter({ limit: 2, windowMs: 1000 });
    rl.fail('1.2.3.4');
    rl.succeed('1.2.3.4');
    rl.fail('1.2.3.4');
    assert.equal(rl.blocked('1.2.3.4'), false);
  });
});
