import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Reads Claude Code's own conversation log so past sessions can be resumed.
 *
 * The size of these files drives the whole design. On this machine there are 95 of
 * them totalling 583 MB, and the largest single session is 487 MB. Reading one whole
 * file would stall the panel, so nothing here ever does: metadata comes from a small
 * head window and a small tail window, read positionally.
 */

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

export const DEFAULT_HEAD_BYTES = 16 * 1024;
export const DEFAULT_TAIL_BYTES = 64 * 1024;

/**
 * How recently a conversation must have been written to assume somebody is still in it.
 *
 * Resuming a session that is already running starts a second process appending to the
 * same transcript. The panel knows about the sessions it started itself, but not one
 * launched from a terminal, and a live session writes to its log constantly, so
 * freshness is the only signal available.
 */
export const LIVE_WINDOW_MS = 90_000;

export function defaultProjectsDir() {
  return process.env.PORTHOLE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
}

/** The same tree holds journal.jsonl and other files that are not conversations. */
export function isSessionFile(name) {
  return SESSION_FILE.test(name);
}

async function readWindow(handle, position, length) {
  if (length <= 0) return '';
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead).toString('utf8');
}

/** Parse whatever lines survive; a window boundary usually slices one in half. */
function parseLines(chunk) {
  const out = [];
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // A partial record at a window edge, or a corrupt line. Neither is fatal.
    }
  }
  return out;
}

const titleOf = (records) => {
  let title = null;
  let prompt = null;
  for (const r of records) {
    if (r.type === 'ai-title' && typeof r.aiTitle === 'string' && r.aiTitle.trim()) title = r.aiTitle.trim();
    if (r.type === 'last-prompt' && typeof r.lastPrompt === 'string' && r.lastPrompt.trim()) prompt = r.lastPrompt.trim();
  }
  return { title, prompt };
};

/**
 * @returns {Promise<{sessionId, cwd, title, lastPrompt, startedAt, lastActivityAt, sizeBytes, projectDir, file, resumable}>}
 */
export async function readSessionMeta(
  file,
  { headBytes = DEFAULT_HEAD_BYTES, tailBytes = DEFAULT_TAIL_BYTES, now = Date.now() } = {},
) {
  const stat = await fsp.stat(file);
  const fallbackId = path.basename(file, '.jsonl');

  let handle;
  let head = [];
  let tail = [];
  try {
    handle = await fsp.open(file, 'r');
    head = parseLines(await readWindow(handle, 0, Math.min(headBytes, stat.size)));

    const tailStart = Math.max(0, stat.size - tailBytes);
    // Skip the tail read when the windows would overlap; the head already has it all.
    if (stat.size > headBytes) {
      tail = parseLines(await readWindow(handle, tailStart, stat.size - tailStart));
    }
  } catch {
    // An unreadable session is listed with whatever the filename tells us.
  } finally {
    await handle?.close();
  }

  const all = [...head, ...tail];

  const withCwd = all.find((r) => typeof r.cwd === 'string' && r.cwd);
  const timestamps = all
    .map((r) => (typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN))
    .filter((n) => Number.isFinite(n));

  // Tail wins over head: a session renamed halfway through should show its current name.
  const headNames = titleOf(head);
  const tailNames = titleOf(tail);
  const title = tailNames.title ?? headNames.title;
  const lastPrompt = tailNames.prompt ?? headNames.prompt;

  const cwd = withCwd?.cwd ?? null;
  const lastActivityAt = timestamps.length ? Math.max(...timestamps) : stat.mtimeMs;

  return {
    likelyLive: now - lastActivityAt < LIVE_WINDOW_MS,
    file,
    projectDir: path.basename(path.dirname(file)),
    sessionId: all.find((r) => typeof r.sessionId === 'string')?.sessionId ?? fallbackId,
    cwd,
    // Directory names encode the path lossily: "E--Programs-claude-local-control-anywhere"
    // cannot be turned back into a path, because the dashes inside the folder name are
    // indistinguishable from separators. Admitting ignorance beats guessing wrong.
    resumable: cwd !== null,
    title: title ?? lastPrompt ?? '(untitled)',
    lastPrompt: lastPrompt ?? null,
    gitBranch: withCwd?.gitBranch ?? null,
    version: withCwd?.version ?? null,
    startedAt: timestamps.length ? Math.min(...timestamps) : stat.birthtimeMs,
    lastActivityAt,
    sizeBytes: stat.size,
  };
}

export async function listSessions({ projectsDir = defaultProjectsDir(), limit = 100 } = {}) {
  let entries;
  try {
    entries = await fsp.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projectsDir, entry.name);
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (isSessionFile(name)) files.push(path.join(dir, name));
    }
  }

  // Sort by mtime before reading anything, so a limit avoids touching old files at all.
  const stamped = [];
  for (const file of files) {
    try {
      stamped.push({ file, mtime: fs.statSync(file).mtimeMs });
    } catch {
      // Vanished between readdir and stat.
    }
  }
  stamped.sort((a, b) => b.mtime - a.mtime);

  const metas = [];
  for (const { file } of stamped.slice(0, limit)) {
    try {
      metas.push(await readSessionMeta(file));
    } catch {
      // Skip anything unreadable rather than failing the whole listing.
    }
  }

  metas.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return metas;
}
