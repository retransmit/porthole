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
    pairings: [],
    viewersCanBrowseFiles: false,
    vapid: null,
  };
}

/**
 * Last-seen file contents per config object, kept outside the object so it never
 * reaches disk. Used to tell a foreign write apart from our own.
 *
 * Contents rather than mtime deliberately. Modification times have millisecond
 * granularity, so a write landing in the same millisecond as the read is invisible,
 * and minting an invite moments after the panel starts is exactly that case. The file
 * is a few kilobytes, so reading it is cheaper than being subtly wrong.
 */
const seenContent = new WeakMap();

function readRaw(dir) {
  try {
    return fs.readFileSync(configPath(dir), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Adopt changes another process made to the config file.
 *
 * The CLI and the running server are separate processes over one file. The server reads
 * it once at startup, so without this an invite minted by `porthole invite` is rejected
 * by the panel it was meant to open. The config object is mutated in place because the
 * http and websocket layers closed over that exact reference.
 *
 * @returns {boolean} true when a foreign change was adopted
 */
export function reloadIfChanged(dir, config) {
  const raw = readRaw(dir);
  if (raw === null) return false;
  if (seenContent.get(config) === raw) return false;

  const fresh = loadConfig(dir);

  config.adminToken = fresh.adminToken;
  config.invites = fresh.invites;
  config.pairings = fresh.pairings;
  config.viewersCanBrowseFiles = fresh.viewersCanBrowseFiles;
  config.vapid = fresh.vapid ?? config.vapid;
  config.pushSubscriptions = fresh.pushSubscriptions ?? config.pushSubscriptions ?? [];

  seenContent.set(config, raw);
  return true;
}

export function loadConfig(dir) {
  fs.mkdirSync(dir, { recursive: true });

  // Keep the exact bytes as well as the parsed form, so change detection can compare
  // file contents rather than a re-serialisation that would differ in formatting.
  const text = readRaw(dir);
  let raw = null;
  try {
    raw = text === null ? null : JSON.parse(text);
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

  const config = {
    version: CONFIG_VERSION,
    adminToken: raw.adminToken,
    invites: Array.isArray(raw.invites) ? raw.invites : [],
    pairings: Array.isArray(raw.pairings) ? raw.pairings : [],
    viewersCanBrowseFiles: raw.viewersCanBrowseFiles === true,
    vapid: raw.vapid ?? null,
    pushSubscriptions: Array.isArray(raw.pushSubscriptions) ? raw.pushSubscriptions : [],
  };
  seenContent.set(config, text);
  return config;
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
  // Record our own write so it is not mistaken for a foreign change on the next check.
  seenContent.set(cfg, json);
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
