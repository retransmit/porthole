import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Read-only file access, confined to one session's working folder.
 *
 * The jail resolves links before deciding, because a junction inside the folder can
 * otherwise point anywhere on the disk. Comparison is on the resolved real paths and
 * requires a separator boundary, so a sibling folder that merely shares the root's
 * name prefix cannot slip through a naive startsWith check.
 */

const WINDOWS = process.platform === 'win32';
const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_ENTRIES = 2000;

/** Windows paths are case-insensitive, so casing must not be a way to smuggle an escape. */
const normalise = (p) => (WINDOWS ? p.toLowerCase() : p);

/** Resolve links where possible, falling back to the nearest existing ancestor. */
function realPathOrNearest(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(realPathOrNearest(parent), path.basename(p));
  }
}

function isInside(root, child) {
  const r = normalise(path.resolve(root));
  const c = normalise(path.resolve(child));
  if (c === r) return true;
  const prefix = r.endsWith(path.sep) ? r : r + path.sep;
  return c.startsWith(prefix);
}

/**
 * @returns {string|null} the absolute path, or null when it would leave the root
 */
export function resolveWithin(root, relative) {
  if (typeof relative !== 'string') return null;
  // A null byte truncates the path at the syscall boundary, so "a.js\0.png" would
  // open "a.js" while passing any check made against the longer string.
  if (relative.includes('\u0000')) return null;

  const absoluteRoot = path.resolve(root);
  const candidate = path.resolve(absoluteRoot, relative);

  if (!isInside(realPathOrNearest(absoluteRoot), realPathOrNearest(candidate))) return null;

  return candidate;
}

function denied(relative) {
  return new Error(`path is outside the session folder, denied: ${relative}`);
}

export async function listDir(root, relative = '') {
  const abs = resolveWithin(root, relative);
  if (!abs) throw denied(relative);

  let dirents;
  try {
    dirents = await fsp.readdir(abs, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`not found: ${relative || '.'}`);
    if (err.code === 'ENOTDIR') throw new Error(`not a directory: ${relative}`);
    throw err;
  }

  const entries = [];
  for (const dirent of dirents.slice(0, MAX_ENTRIES)) {
    const type = dirent.isDirectory() ? 'dir' : dirent.isFile() ? 'file' : 'other';
    let size = null;
    let mtime = null;
    try {
      const st = await fsp.stat(path.join(abs, dirent.name));
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      // A dangling link or a file that vanished mid-listing is still worth showing.
    }
    entries.push({ name: dirent.name, type, size, mtime });
  }

  entries.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (b.type === 'dir' && a.type !== 'dir') return 1;
    return a.name.localeCompare(b.name);
  });

  return {
    path: relative,
    truncated: dirents.length > MAX_ENTRIES,
    entries,
  };
}

/** A NUL byte in the first block is the cheap, reliable binary tell. */
function looksBinary(buf) {
  return buf.includes(0);
}

export async function readTextFile(root, relative, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const abs = resolveWithin(root, relative);
  if (!abs) throw denied(relative);

  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`not found: ${relative}`);
    throw err;
  }
  if (stat.isDirectory()) throw new Error(`not a file: ${relative}`);

  const handle = await fsp.open(abs, 'r');
  try {
    const length = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, 0);
    const slice = buf.subarray(0, bytesRead);
    const binary = looksBinary(slice);

    return {
      path: relative,
      size: stat.size,
      mtime: stat.mtimeMs,
      truncated: stat.size > maxBytes,
      binary,
      text: binary ? null : slice.toString('utf8'),
    };
  } finally {
    await handle.close();
  }
}
