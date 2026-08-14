import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { safeEqual } from './auth.js';

const CONFIG_VERSION = 1;

/** Roles an invite may carry. Admin is never handed out as an invite. */
const INVITE_ROLES = new Set(['view', 'control']);

/** Lives in the user profile, deliberately outside any repo, so it cannot be committed. */
export function defaultStateDir() {
  return process.env.PORTHOLE_STATE_DIR || path.join(os.homedir(), '.porthole');
}

export function configPath(dir) {
  return path.join(dir, 'config.json');
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function defaults() {
  return {
    version: CONFIG_VERSION,
    adminToken: newToken(),
    invites: [],
    viewersCanBrowseFiles: false,
    vapid: null,
  };
}

export function loadConfig(dir) {
  fs.mkdirSync(dir, { recursive: true });

  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(configPath(dir), 'utf8'));
  } catch {
    raw = null;
  }

  // A missing or unusable file is not an error worth halting for. Mint a fresh
  // identity rather than leaving the operator locked out of their own panel.
  if (!raw || typeof raw !== 'object' || !/^[0-9a-f]{64}$/.test(raw.adminToken ?? '')) {
    const fresh = defaults();
    saveConfig(dir, fresh);
    return fresh;
  }

  return {
    version: CONFIG_VERSION,
    adminToken: raw.adminToken,
    invites: Array.isArray(raw.invites) ? raw.invites : [],
    viewersCanBrowseFiles: raw.viewersCanBrowseFiles === true,
    vapid: raw.vapid ?? null,
  };
}

/**
 * Serialise before touching disk, so a bad object throws without destroying the
 * config that is already there. The write itself goes via a temp file and a rename
 * so a crash mid-write cannot leave a half-written token file behind.
 */
export function saveConfig(dir, cfg) {
  const json = JSON.stringify(cfg, null, 2);
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, json, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

export function mintInvite(cfg, { role = 'view', label = '', expiresAt = null } = {}) {
  if (!INVITE_ROLES.has(role)) {
    throw new Error(`invalid invite role "${role}", expected one of: ${[...INVITE_ROLES].join(', ')}`);
  }
  const invite = {
    id: crypto.randomBytes(6).toString('hex'),
    token: newToken(),
    role,
    label: String(label ?? '').slice(0, 64),
    createdAt: Date.now(),
    expiresAt,
    revoked: false,
  };
  cfg.invites.push(invite);
  return invite;
}

export function revokeInvite(cfg, id) {
  const invite = cfg.invites.find((i) => i.id === id);
  if (!invite) return false;
  invite.revoked = true;
  return true;
}

/**
 * @returns {{role: string, label: string, id: string} | null}
 */
export function resolveToken(cfg, token, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || token.length === 0) return null;

  if (safeEqual(token, cfg.adminToken)) {
    return { role: 'admin', label: 'admin', id: 'admin' };
  }

  for (const invite of cfg.invites) {
    if (invite.revoked) continue;
    if (!safeEqual(token, invite.token)) continue;
    if (invite.expiresAt != null && now > invite.expiresAt) return null;
    return { role: invite.role, label: invite.label, id: invite.id };
  }

  return null;
}
