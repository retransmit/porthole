import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { chooseBindHost, buildUrl, tailscaleCandidates } from '../src/net.js';

describe('tailscaleCandidates()', () => {
  test('tries the bare command first, so a PATH install always wins', () => {
    assert.equal(tailscaleCandidates('linux')[0], 'tailscale');
  });

  test('knows where the windows installer puts it', () => {
    const found = tailscaleCandidates('win32');
    assert.ok(found.some((p) => p.includes('Program Files') && p.endsWith('tailscale.exe')));
  });

  test('knows the macos app bundle, where it is not on PATH by default', () => {
    const found = tailscaleCandidates('darwin');
    assert.ok(found.some((p) => p.includes('Tailscale.app')));
  });

  test('covers both intel and apple silicon homebrew prefixes on macos', () => {
    const found = tailscaleCandidates('darwin');
    assert.ok(found.some((p) => p.startsWith('/usr/local/bin')), 'intel homebrew');
    assert.ok(found.some((p) => p.startsWith('/opt/homebrew/bin')), 'apple silicon homebrew');
  });

  test('covers the usual linux locations', () => {
    const found = tailscaleCandidates('linux');
    assert.ok(found.some((p) => p === '/usr/bin/tailscale'));
    assert.ok(found.some((p) => p === '/usr/local/bin/tailscale'));
  });

  test('does not offer windows paths on linux', () => {
    assert.ok(!tailscaleCandidates('linux').some((p) => p.includes('Program Files')));
  });
});

describe('chooseBindHost()', () => {
  test('binds to the tailnet address when one is available', () => {
    const out = chooseBindHost({ tailscaleIp: '100.80.162.29' });
    assert.equal(out.host, '100.80.162.29');
    assert.equal(out.reason, 'tailscale');
  });

  test('falls back to loopback when there is no tailnet address', () => {
    const out = chooseBindHost({ tailscaleIp: null });
    assert.equal(out.host, '127.0.0.1');
    assert.equal(out.reason, 'loopback');
  });

  test('an explicit host wins over the tailnet address', () => {
    const out = chooseBindHost({ explicitHost: '192.168.1.5', tailscaleIp: '100.80.162.29' });
    assert.equal(out.host, '192.168.1.5');
    assert.equal(out.reason, 'explicit');
  });

  test('binding every interface requires asking for it, and is flagged', () => {
    const out = chooseBindHost({ allowAll: true, tailscaleIp: '100.80.162.29' });
    assert.equal(out.host, '0.0.0.0');
    assert.equal(out.exposed, true);
  });

  test('the tailnet default is not treated as exposed', () => {
    assert.equal(chooseBindHost({ tailscaleIp: '100.80.162.29' }).exposed, false);
  });

  test('an explicit 0.0.0.0 is still recognised as exposed', () => {
    assert.equal(chooseBindHost({ explicitHost: '0.0.0.0' }).exposed, true);
  });

  test('loopback is never treated as exposed', () => {
    assert.equal(chooseBindHost({ tailscaleIp: null }).exposed, false);
  });
});

describe('buildUrl()', () => {
  test('builds a plain url with the port', () => {
    assert.equal(buildUrl({ host: '100.80.162.29', port: 7317 }), 'http://100.80.162.29:7317');
  });

  test('prefers the tailnet dns name when one is known', () => {
    const url = buildUrl({ host: '100.80.162.29', port: 7317, dnsName: 'dexel.tailfe839d.ts.net.' });
    assert.equal(url, 'http://dexel.tailfe839d.ts.net:7317');
  });

  test('appends a token when given, so a link works on first open', () => {
    const url = buildUrl({ host: '127.0.0.1', port: 7317, token: 'abc' });
    assert.equal(url, 'http://127.0.0.1:7317/?t=abc');
  });

  test('wraps a bare ipv6 address in brackets', () => {
    assert.equal(buildUrl({ host: 'fd7a:115c:a1e0::1', port: 7317 }), 'http://[fd7a:115c:a1e0::1]:7317');
  });

  test('omits the port when it is the default for the scheme', () => {
    assert.equal(buildUrl({ host: 'dexel.ts.net', port: 443, scheme: 'https' }), 'https://dexel.ts.net');
  });
});
