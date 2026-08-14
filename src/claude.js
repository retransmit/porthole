/**
 * Constructing the command line for a Claude Code child process.
 *
 * Kept apart from the session manager because argument construction is exactly the
 * sort of thing that breaks quietly: a wrong flag produces a process that starts and
 * then behaves subtly differently, which is far harder to notice than a crash.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {{sessionId?: string, resumeId?: string, settingsPath?: string, extraArgs?: string[]}} opts
 * @returns {string[]}
 */
export function buildClaudeArgs({ sessionId = null, resumeId = null, settingsPath = null, extraArgs = [] } = {}) {
  if (!sessionId && !resumeId) {
    throw new Error('buildClaudeArgs needs either a session id to mint or a resume id');
  }

  const args = [];

  if (resumeId) {
    // Resuming adopts the id the conversation already has, so --session-id would both
    // be redundant and conflict with it. Never send both.
    if (!UUID.test(resumeId)) throw new Error(`resume id must be a uuid, received "${resumeId}"`);
    args.push('--resume', resumeId);
  } else {
    // Minting the id ourselves is what makes resume reliable later: the panel always
    // knows what to ask for, instead of scraping it back out of the log.
    if (!UUID.test(sessionId)) throw new Error(`session id must be a uuid, received "${sessionId}"`);
    args.push('--session-id', sessionId);
  }

  if (settingsPath) args.push('--settings', settingsPath);

  for (const arg of extraArgs) {
    if (typeof arg !== 'string') throw new Error('extra claude arguments must be strings');
    args.push(arg);
  }

  return args;
}

export function resolveClaudePath({ override = null, env = process.env } = {}) {
  if (override) return override;
  if (env.PORTHOLE_CLAUDE_PATH) return env.PORTHOLE_CLAUDE_PATH;
  // A bare name lets the OS resolve it on PATH, which is where the installer puts it.
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}
