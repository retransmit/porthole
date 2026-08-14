import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveWithin } from './files.js';

const run = promisify(execFile);

/** Diffs can be enormous. Past this we truncate rather than posting megabytes. */
export const MAX_DIFF_BYTES = 1024 * 1024;

function statusOf(index, worktree) {
  if (index === '?' && worktree === '?') return 'untracked';
  if (index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A') || (index === 'D' && worktree === 'D')) {
    return 'conflicted';
  }
  if (index === 'R' || worktree === 'R') return 'renamed';
  if (index === 'A' || worktree === 'A') return 'added';
  if (index === 'D' || worktree === 'D') return 'deleted';
  return 'modified';
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * The -z form is used specifically because the default output quotes and escapes
 * paths containing spaces or non-ascii characters. NUL separation sidesteps that
 * entire class of parsing bug.
 */
export function parsePorcelain(text) {
  const records = String(text ?? '').split('\u0000');
  const entries = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;

    const index = record[0];
    const worktree = record[1];
    const filePath = record.slice(3);

    const entry = {
      path: filePath,
      index,
      worktree,
      status: statusOf(index, worktree),
      staged: index !== ' ' && index !== '?',
      renamedFrom: null,
    };

    // A rename or copy spends a second record on the original path.
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
      entry.renamedFrom = records[++i] ?? null;
    }

    entries.push(entry);
  }

  return entries;
}

/** Arguments always go as an array, never through a shell, so paths cannot inject. */
async function git(cwd, args, { maxBuffer = MAX_DIFF_BYTES } = {}) {
  return run('git', args, { cwd, maxBuffer, timeout: 20_000, windowsHide: true });
}

export async function isGitRepo(cwd) {
  try {
    const { stdout } = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export async function currentBranch(cwd) {
  try {
    const { stdout } = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function gitStatus(cwd) {
  if (!(await isGitRepo(cwd))) return { repo: false, branch: null, entries: [] };
  const { stdout } = await git(cwd, ['status', '--porcelain=v1', '-z']);
  return { repo: true, branch: await currentBranch(cwd), entries: parsePorcelain(stdout) };
}

export async function gitDiff(cwd, { file = null, staged = false } = {}) {
  if (!(await isGitRepo(cwd))) return { repo: false, diff: '', truncated: false };

  const args = ['diff', '--no-color', '--no-ext-diff'];
  if (staged) args.push('--staged');
  if (file) {
    // The path is confined to the session folder before git ever sees it.
    if (!resolveWithin(cwd, file)) throw new Error(`path is outside the session folder, denied: ${file}`);
    args.push('--', file);
  }

  try {
    const { stdout } = await git(cwd, args);
    return { repo: true, diff: stdout, truncated: false };
  } catch (err) {
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return { repo: true, diff: String(err.stdout ?? '').slice(0, MAX_DIFF_BYTES), truncated: true };
    }
    throw err;
  }
}
