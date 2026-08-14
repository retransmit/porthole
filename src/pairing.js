import crypto from 'node:crypto';

import { safeEqual } from './auth.js';
import { mintInvite } from './config.js';

/**
 * One-time codes for pairing a phone.
 *
 * Typing a 64 character token on a phone keyboard is miserable, so the CLI shows a QR
 * instead. What the QR carries is deliberately not the token: a QR holding a real
 * credential is a permanent secret displayed on a screen, which survives in screenshots
 * and over shoulders. A code that is short lived and already spent is worth nothing to
 * whoever photographs it afterwards.
 */

/** No O/0 or I/1. These get read aloud and typed by hand when a camera will not focus. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 12;

export const PAIRING_TTL_MS = 2 * 60 * 1000;

const PAIRING_ROLES = new Set(['view', 'control']);

function randomCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    // Rejection-free modulo is fine here: 256 % 32 === 0, so the bias is zero.
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

/** Codes are compared without dashes or case, because people retype them. */
const canonical = (code) =>
  typeof code === 'string' ? code.toUpperCase().replace(/[^A-Z2-9]/g, '') : null;

export function mintPairingCode(
  config,
  { role = 'view', label = 'phone', canCreate = false } = {},
  { now = Date.now() } = {},
) {
  if (!PAIRING_ROLES.has(role)) {
    throw new Error(`invalid pairing role "${role}", expected one of: ${[...PAIRING_ROLES].join(', ')}`);
  }

  if (!Array.isArray(config.pairings)) config.pairings = [];
  // Sweep on mint, so an unused code cannot accumulate in the config indefinitely.
  config.pairings = config.pairings.filter((p) => !p.claimed && p.expiresAt > now);

  const code = randomCode();
  const pairing = {
    canonical: canonical(code),
    role,
    label: String(label ?? '').slice(0, 64),
    createdAt: now,
    expiresAt: now + PAIRING_TTL_MS,
    claimed: false,
    // Carried through to the invite the code is exchanged for.
    canCreate: canCreate === true && role === 'control',
  };
  config.pairings.push(pairing);

  return { code, expiresAt: pairing.expiresAt, role, label: pairing.label, canCreate: pairing.canCreate };
}

/**
 * Exchange a code for a real invite token. Returns null for anything that is not a
 * live, unclaimed code: unknown, expired, or already used.
 *
 * @returns {{token: string, role: string, label: string} | null}
 */
export function claimPairingCode(config, code, { now = Date.now() } = {}) {
  const wanted = canonical(code);
  if (!wanted) return null;
  if (!Array.isArray(config.pairings)) return null;

  for (const pairing of config.pairings) {
    if (pairing.claimed) continue;
    if (!safeEqual(wanted, pairing.canonical)) continue;
    if (now >= pairing.expiresAt) return null;

    // Marked before the invite is minted, so a concurrent second claim cannot also
    // succeed and leave two live tokens behind.
    pairing.claimed = true;
    pairing.claimedAt = now;

    const invite = mintInvite(config, {
      role: pairing.role,
      label: pairing.label,
      canCreate: pairing.canCreate === true,
    });
    return { token: invite.token, role: invite.role, label: invite.label };
  }

  return null;
}

export function buildPairingUri({ host, port, code, name }) {
  const params = new URLSearchParams({ h: String(host), p: String(port), c: code });
  if (name) params.set('n', name);
  return `porthole://pair?${params.toString()}`;
}

/** @returns {{host: string, port: number, code: string, name: string|null} | null} */
export function parsePairingUri(uri) {
  if (typeof uri !== 'string' || !uri) return null;

  let url;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }

  if (url.protocol !== 'porthole:' || url.host !== 'pair') return null;

  const host = url.searchParams.get('h');
  const port = Number(url.searchParams.get('p'));
  const code = url.searchParams.get('c');

  if (!host || !code) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  return { host, port, code, name: url.searchParams.get('n') };
}
