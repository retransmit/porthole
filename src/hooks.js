import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Wiring Claude Code's own hooks so the panel learns when a session wants attention.
 *
 * The alternative was scraping the terminal for a prompt box, which breaks every time
 * the UI shifts a character. Claude already emits a Notification event when it is
 * waiting on the user and a Stop event when it finishes a turn, so the panel asks for
 * those directly and treats screen heuristics as a fallback only.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

export function notifyScriptPath() {
  return path.resolve(here, '..', 'hook', 'notify.mjs');
}

/**
 * Hook commands run through a shell, so the script path is quoted. The endpoint and
 * token are passed as arguments rather than environment variables because Claude Code
 * spawns hooks itself and we cannot rely on inheriting our own environment.
 */
export function buildHookSettings({ endpoint, hookToken, script = notifyScriptPath(), events = ['Notification', 'Stop'] }) {
  const command = `node "${script}" --endpoint "${endpoint}" --token "${hookToken}"`;
  const hooks = {};
  for (const event of events) {
    hooks[event] = [{ hooks: [{ type: 'command', command, timeout: 10 }] }];
  }
  return { hooks };
}

export async function writeHookSettings(stateDir, sessionId, settings) {
  const dir = path.join(stateDir, 'sessions');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.settings.json`);
  await fsp.writeFile(file, JSON.stringify(settings, null, 2), 'utf8');
  return file;
}

export async function removeHookSettings(stateDir, sessionId) {
  try {
    await fsp.rm(path.join(stateDir, 'sessions', `${sessionId}.settings.json`), { force: true });
  } catch {
    // Leaving a stale settings file behind is harmless.
  }
}

/** Maps a Claude Code hook event onto what the panel should tell the user. */
export function attentionFromHook(event) {
  switch (event) {
    case 'Notification':
      return { kind: 'needs-input', text: 'Claude is waiting for you' };
    case 'Stop':
      return { kind: 'done', text: 'Claude finished its turn' };
    default:
      return null;
  }
}
