#!/usr/bin/env node
/**
 * Invoked by Claude Code's Notification and Stop hooks.
 *
 * Claude passes the event as JSON on stdin. This forwards the interesting parts to a
 * running Porthole panel and exits. It must never block a session: any failure is
 * swallowed and the exit code stays 0, because a non-zero hook exit is something
 * Claude Code surfaces to the user, and a panel that is not running is not an error.
 */

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};

const endpoint = flag('endpoint');
const token = flag('token');

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

const timeout = setTimeout(() => process.exit(0), 4000);
timeout.unref?.();

try {
  const raw = await readStdin();
  const event = raw ? JSON.parse(raw) : {};

  if (endpoint && token) {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        sessionId: event.session_id ?? null,
        event: event.hook_event_name ?? null,
        message: event.message ?? null,
        cwd: event.cwd ?? null,
      }),
      signal: AbortSignal.timeout(3000),
    });
  }
} catch {
  // A panel that has stopped, or a malformed event, must not disturb the session.
}

clearTimeout(timeout);
process.exit(0);
