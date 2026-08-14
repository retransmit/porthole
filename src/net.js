import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Where to look for the tailscale binary, most likely first.
 *
 * A bare name always leads, so a PATH install wins wherever it is. After that the
 * lists diverge by platform: the macOS app bundle in particular ships the binary
 * inside itself and does not put it on PATH, which is the case that silently breaks
 * tailnet detection on a Mac.
 */
export function tailscaleCandidates(platform = process.platform) {
  const candidates = ['tailscale'];

  if (platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Tailscale\\tailscale.exe',
      'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
    );
  } else if (platform === 'darwin') {
    candidates.push(
      '/usr/local/bin/tailscale',
      '/opt/homebrew/bin/tailscale',
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    );
  } else {
    candidates.push('/usr/bin/tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale');
  }

  return candidates;
}

/**
 * Run tailscale wherever it lives. Reports which binary answered so callers can say
 * something useful when it is missing entirely.
 */
export async function runTailscale(args, { timeout = 20_000 } = {}) {
  let notFound = null;

  for (const bin of tailscaleCandidates()) {
    try {
      const { stdout, stderr } = await run(bin, args, { timeout, windowsHide: true });
      return { ok: true, stdout, stderr, bin };
    } catch (err) {
      // Wrong path for this machine: try the next candidate. Anything else means
      // tailscale was found but could not answer, so stop looking.
      if (err.code === 'ENOENT') {
        notFound = err;
        continue;
      }
      return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? '', error: err, bin };
    }
  }

  return { ok: false, stdout: '', stderr: '', error: notFound ?? new Error('tailscale was not found') };
}

const isExposed = (host) => host === '0.0.0.0' || host === '::' || host === '';

/**
 * Where to listen.
 *
 * The default is the tailnet address rather than every interface, so that starting
 * the panel does not quietly publish a shell-capable agent to whatever coffee shop
 * network the machine happens to be on. Listening broadly stays possible but has to
 * be asked for, and is reported back as `exposed` so the caller can say so out loud.
 */
export function chooseBindHost({ explicitHost = null, tailscaleIp = null, allowAll = false } = {}) {
  if (explicitHost) return { host: explicitHost, reason: 'explicit', exposed: isExposed(explicitHost) };
  if (allowAll) return { host: '0.0.0.0', reason: 'all-interfaces', exposed: true };
  if (tailscaleIp) return { host: tailscaleIp, reason: 'tailscale', exposed: false };
  return { host: '127.0.0.1', reason: 'loopback', exposed: false };
}

const DEFAULT_PORTS = { http: 80, https: 443 };

export function buildUrl({ host, port, dnsName = null, token = null, scheme = 'http' }) {
  const bare = dnsName ? dnsName.replace(/\.$/, '') : host;
  const authority = !dnsName && bare.includes(':') ? `[${bare}]` : bare;
  const portPart = port === DEFAULT_PORTS[scheme] ? '' : `:${port}`;
  const base = `${scheme}://${authority}${portPart}`;
  return token ? `${base}/?t=${token}` : base;
}

async function tailscale(args) {
  const result = await runTailscale(args, { timeout: 5000 });
  return result.ok ? result.stdout : null;
}

export async function tailscaleIPv4() {
  const out = await tailscale(['ip', '-4']);
  const ip = out?.trim().split(/\s+/)[0];
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip ?? '') ? ip : null;
}

/** The tailnet DNS name makes a far friendlier link than a 100.x address. */
export async function tailscaleSelf() {
  const out = await tailscale(['status', '--json']);
  if (!out) return null;
  try {
    const self = JSON.parse(out).Self;
    return self ? { dnsName: self.DNSName ?? null, hostName: self.HostName ?? null, ips: self.TailscaleIPs ?? [] } : null;
  } catch {
    return null;
  }
}

/** Identifies the tailnet peer behind a connection, for the audit log. */
export async function tailscaleWhois(ip) {
  if (!ip) return null;
  const out = await tailscale(['whois', '--json', ip]);
  if (!out) return null;
  try {
    const parsed = JSON.parse(out);
    return {
      login: parsed.UserProfile?.LoginName ?? null,
      display: parsed.UserProfile?.DisplayName ?? null,
      device: parsed.Node?.Name ?? null,
    };
  } catch {
    return null;
  }
}

/** Strips the ::ffff: prefix Node reports for ipv4 peers on a dual-stack socket. */
export function normaliseRemoteAddress(address) {
  if (typeof address !== 'string') return null;
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}
