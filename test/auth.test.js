import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  can,
  safeEqual,
  parseCookies,
  serializeCookie,
  extractToken,
  RateLimiter,
} from '../src/auth.js';

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
