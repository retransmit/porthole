import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadConfig,
  mintInvite,
  reloadIfChanged,
  revokeInvite,
  resolveToken,
  saveConfig,
} from '../src/config.js';

/**
 * The CLI and the running server are separate processes sharing one config file. The
 * server loaded it once at startup, so without this an invite minted by `porthole
 * invite` is rejected by the very panel it was meant to open, with a bare 401 and no
 * hint as to why.
 */
describe('reloadIfChanged()', () => {
  test('reports no change when the file has not been touched', () => {
    const cfg = loadConfig(dir);
    assert.equal(reloadIfChanged(dir, cfg), false);
  });

  test('picks up an invite another process minted', () => {
    const server = loadConfig(dir);

    // A second process, standing in for the CLI.
    const cli = loadConfig(dir);
    const invite = mintInvite(cli, { role: 'view', label: 'alice' });
    saveConfig(dir, cli);

    assert.equal(resolveToken(server, invite.token), null, 'not visible before reload');
    assert.equal(reloadIfChanged(dir, server), true);
    assert.equal(resolveToken(server, invite.token).label, 'alice');
  });

  test('keeps the same config object, since the server holds a reference to it', () => {
    const server = loadConfig(dir);
    const cli = loadConfig(dir);
    mintInvite(cli, { role: 'view', label: 'bob' });
    saveConfig(dir, cli);

    const before = server;
    reloadIfChanged(dir, server);
    assert.equal(server, before);
    assert.equal(server.invites.length, 1);
  });

  test('picks up a pairing code another process minted', () => {
    const server = loadConfig(dir);
    const cli = loadConfig(dir);
    cli.pairings = [{ canonical: 'ABCD', role: 'view', label: 'phone', expiresAt: Date.now() + 60_000, claimed: false }];
    saveConfig(dir, cli);

    reloadIfChanged(dir, server);
    assert.equal(server.pairings.length, 1);
  });

  test('does not reload in response to the server saving its own config', () => {
    const cfg = loadConfig(dir);
    mintInvite(cfg, { role: 'view', label: 'self' });
    saveConfig(dir, cfg);
    assert.equal(reloadIfChanged(dir, cfg), false, 'our own write is not a foreign change');
  });

  test('reports no change when the config file is missing', () => {
    const cfg = loadConfig(dir);
    fs.rmSync(path.join(dir, 'config.json'));
    assert.equal(reloadIfChanged(dir, cfg), false);
  });
});

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-cfg-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig()', () => {
  test('creates the config directory on first run', () => {
    const target = path.join(dir, 'nested', 'state');
    loadConfig(target);
    assert.equal(fs.existsSync(path.join(target, 'config.json')), true);
  });

  test('mints an admin token with 32 bytes of entropy', () => {
    const cfg = loadConfig(dir);
    assert.match(cfg.adminToken, /^[0-9a-f]{64}$/);
  });

  test('keeps the same admin token across reloads', () => {
    const first = loadConfig(dir).adminToken;
    const second = loadConfig(dir).adminToken;
    assert.equal(first, second);
  });

  test('mints a different admin token for a different state directory', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-cfg-'));
    try {
      assert.notEqual(loadConfig(dir).adminToken, loadConfig(other).adminToken);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  test('starts with no invites and viewer file browsing switched off', () => {
    const cfg = loadConfig(dir);
    assert.deepEqual(cfg.invites, []);
    assert.equal(cfg.viewersCanBrowseFiles, false);
  });

  test('recovers from a corrupt config file by minting a fresh one', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), '{ this is not json');
    const cfg = loadConfig(dir);
    assert.match(cfg.adminToken, /^[0-9a-f]{64}$/);
  });
});

describe('mintInvite()', () => {
  test('returns an invite carrying the requested role and label', () => {
    const cfg = loadConfig(dir);
    const invite = mintInvite(cfg, { role: 'view', label: 'alice' });
    assert.equal(invite.role, 'view');
    assert.equal(invite.label, 'alice');
  });

  test('gives the invite a 32 byte token', () => {
    const cfg = loadConfig(dir);
    assert.match(mintInvite(cfg, { role: 'view', label: 'a' }).token, /^[0-9a-f]{64}$/);
  });

  test('appends the invite to the config', () => {
    const cfg = loadConfig(dir);
    mintInvite(cfg, { role: 'view', label: 'alice' });
    mintInvite(cfg, { role: 'control', label: 'bob' });
    assert.equal(cfg.invites.length, 2);
  });

  test('issues a distinct token per invite', () => {
    const cfg = loadConfig(dir);
    const a = mintInvite(cfg, { role: 'view', label: 'a' }).token;
    const b = mintInvite(cfg, { role: 'view', label: 'b' }).token;
    assert.notEqual(a, b);
  });

  test('refuses to mint an admin invite', () => {
    const cfg = loadConfig(dir);
    assert.throws(() => mintInvite(cfg, { role: 'admin', label: 'x' }), /role/i);
  });

  test('refuses an unrecognised role', () => {
    const cfg = loadConfig(dir);
    assert.throws(() => mintInvite(cfg, { role: 'root', label: 'x' }), /role/i);
  });

  test('defaults to the view role when none is given', () => {
    const cfg = loadConfig(dir);
    assert.equal(mintInvite(cfg, { label: 'a' }).role, 'view');
  });
});

describe('resolveToken()', () => {
  test('resolves the admin token to the admin role', () => {
    const cfg = loadConfig(dir);
    assert.equal(resolveToken(cfg, cfg.adminToken).role, 'admin');
  });

  test('resolves an invite token to that invite role and label', () => {
    const cfg = loadConfig(dir);
    const invite = mintInvite(cfg, { role: 'control', label: 'bob' });
    const found = resolveToken(cfg, invite.token);
    assert.equal(found.role, 'control');
    assert.equal(found.label, 'bob');
  });

  test('returns null for an unknown token', () => {
    const cfg = loadConfig(dir);
    assert.equal(resolveToken(cfg, 'f'.repeat(64)), null);
  });

  test('returns null for a revoked invite', () => {
    const cfg = loadConfig(dir);
    const invite = mintInvite(cfg, { role: 'control', label: 'bob' });
    revokeInvite(cfg, invite.id);
    assert.equal(resolveToken(cfg, invite.token), null);
  });

  test('returns null for an expired invite', () => {
    const cfg = loadConfig(dir);
    const invite = mintInvite(cfg, { role: 'view', label: 'temp', expiresAt: 500 });
    assert.equal(resolveToken(cfg, invite.token, { now: 400 }).role, 'view');
    assert.equal(resolveToken(cfg, invite.token, { now: 600 }), null);
  });

  test('returns null for empty or missing input', () => {
    const cfg = loadConfig(dir);
    assert.equal(resolveToken(cfg, ''), null);
    assert.equal(resolveToken(cfg, null), null);
    assert.equal(resolveToken(cfg, undefined), null);
  });
});

describe('saveConfig()', () => {
  test('round-trips invites through disk', () => {
    const cfg = loadConfig(dir);
    const invite = mintInvite(cfg, { role: 'control', label: 'bob' });
    saveConfig(dir, cfg);

    const reloaded = loadConfig(dir);
    assert.equal(resolveToken(reloaded, invite.token).label, 'bob');
  });

  test('leaves the previous config intact if serialisation fails', () => {
    const cfg = loadConfig(dir);
    const original = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');

    const circular = { ...cfg };
    circular.self = circular;
    assert.throws(() => saveConfig(dir, circular));

    assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), original);
  });
});
