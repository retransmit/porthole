import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, resolveToken } from '../src/config.js';
import {
  mintPairingCode,
  claimPairingCode,
  buildPairingUri,
  parsePairingUri,
  PAIRING_TTL_MS,
} from '../src/pairing.js';

let dir;
let config;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-pair-'));
  config = loadConfig(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('mintPairingCode()', () => {
  test('produces a short code from an unambiguous alphabet', () => {
    const { code } = mintPairingCode(config, { role: 'control', label: 'phone' });
    // No O/0 or I/1, because these get read aloud and typed by hand.
    assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789-]+$/);
    assert.ok(code.replace(/-/g, '').length >= 10, `code too short: ${code}`);
  });

  test('records the code against the config', () => {
    mintPairingCode(config, { role: 'view', label: 'phone' });
    assert.equal(config.pairings.length, 1);
  });

  test('issues a distinct code each time', () => {
    const a = mintPairingCode(config, { role: 'view', label: 'a' }).code;
    const b = mintPairingCode(config, { role: 'view', label: 'b' }).code;
    assert.notEqual(a, b);
  });

  test('expires two minutes out by default', () => {
    const now = 1_000_000;
    const { expiresAt } = mintPairingCode(config, { role: 'view', label: 'p' }, { now });
    assert.equal(expiresAt, now + PAIRING_TTL_MS);
  });

  test('refuses to pair an admin role, the same as invites', () => {
    assert.throws(() => mintPairingCode(config, { role: 'admin', label: 'x' }), /role/i);
  });

  test('drops codes that have already expired, so the config cannot grow forever', () => {
    mintPairingCode(config, { role: 'view', label: 'old' }, { now: 0 });
    mintPairingCode(config, { role: 'view', label: 'new' }, { now: 10 * 60_000 });
    assert.equal(config.pairings.length, 1);
    assert.equal(config.pairings[0].label, 'new');
  });
});

describe('claimPairingCode()', () => {
  test('exchanges a valid code for a real token', () => {
    const { code } = mintPairingCode(config, { role: 'control', label: 'phone' });
    const claimed = claimPairingCode(config, code);
    assert.match(claimed.token, /^[0-9a-f]{64}$/);
  });

  test('the issued token carries the role and label the code was minted with', () => {
    const { code } = mintPairingCode(config, { role: 'control', label: 'phone' });
    const claimed = claimPairingCode(config, code);
    const identity = resolveToken(config, claimed.token);
    assert.equal(identity.role, 'control');
    assert.equal(identity.label, 'phone');
  });

  test('refuses a second claim, which is the whole point of a one-time code', () => {
    const { code } = mintPairingCode(config, { role: 'view', label: 'phone' });
    assert.ok(claimPairingCode(config, code));
    assert.equal(claimPairingCode(config, code), null);
  });

  test('refuses a code past its expiry', () => {
    const { code } = mintPairingCode(config, { role: 'view', label: 'p' }, { now: 0 });
    assert.equal(claimPairingCode(config, code, { now: PAIRING_TTL_MS + 1 }), null);
  });

  test('accepts a code right up to the expiry moment', () => {
    const { code } = mintPairingCode(config, { role: 'view', label: 'p' }, { now: 0 });
    assert.ok(claimPairingCode(config, code, { now: PAIRING_TTL_MS - 1 }));
  });

  test('refuses an unknown code', () => {
    assert.equal(claimPairingCode(config, 'ZZZZ-ZZZZ-ZZ'), null);
  });

  test('refuses empty or missing input rather than throwing', () => {
    assert.equal(claimPairingCode(config, ''), null);
    assert.equal(claimPairingCode(config, null), null);
    assert.equal(claimPairingCode(config, undefined), null);
  });

  test('ignores case and dashes, since the code may be typed by hand', () => {
    const { code } = mintPairingCode(config, { role: 'view', label: 'p' });
    const mangled = code.toLowerCase().replace(/-/g, '');
    assert.ok(claimPairingCode(config, mangled));
  });

  test('a claimed code does not leave a usable invite behind if it is reused', () => {
    const { code } = mintPairingCode(config, { role: 'view', label: 'p' });
    const first = claimPairingCode(config, code);
    claimPairingCode(config, code);
    // Exactly one invite should exist for this pairing, not two.
    assert.equal(config.invites.filter((i) => i.token === first.token).length, 1);
    assert.equal(config.invites.length, 1);
  });
});

describe('buildPairingUri() and parsePairingUri()', () => {
  const sample = { host: 'dexel.tailfe839d.ts.net', port: 7317, code: 'ABCD-EFGH-JK', name: 'dexel' };

  test('round-trips through a uri', () => {
    const parsed = parsePairingUri(buildPairingUri(sample));
    assert.equal(parsed.host, sample.host);
    assert.equal(parsed.port, sample.port);
    assert.equal(parsed.code, sample.code);
    assert.equal(parsed.name, sample.name);
  });

  test('uses a scheme the app can register for', () => {
    assert.match(buildPairingUri(sample), /^porthole:\/\/pair\?/);
  });

  test('keeps the uri short enough to scan reliably', () => {
    // Dense QR codes fail on cheap cameras in poor light.
    assert.ok(buildPairingUri(sample).length < 120, buildPairingUri(sample));
  });

  test('rejects a uri with the wrong scheme', () => {
    assert.equal(parsePairingUri('https://evil.example/pair?c=ABC'), null);
  });

  test('rejects a malformed uri rather than throwing', () => {
    assert.equal(parsePairingUri('not a uri at all'), null);
    assert.equal(parsePairingUri(''), null);
    assert.equal(parsePairingUri(null), null);
  });

  test('rejects a uri missing the code', () => {
    assert.equal(parsePairingUri('porthole://pair?h=x&p=7317'), null);
  });

  test('rejects a non-numeric port', () => {
    assert.equal(parsePairingUri('porthole://pair?h=x&p=abc&c=ABCD'), null);
  });
});
