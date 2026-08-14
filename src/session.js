import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';

import * as pty from '@lydell/node-pty';
// These three ship as CommonJS. Under ESM they must come in as default imports.
import headless from '@xterm/headless';
import serializePkg from '@xterm/addon-serialize';
import unicode11Pkg from '@xterm/addon-unicode11';

const { Terminal } = headless;
const { SerializeAddon } = serializePkg;
const { Unicode11Addon } = unicode11Pkg;

export const DEFAULT_SCROLLBACK = 5000;

/**
 * Stop the child we started, and nothing else.
 *
 * Deliberately NOT node-pty's own `kill()`. On Windows that path forks a helper, calls
 * AttachConsole against the child's pid, asks the OS for every process sharing that
 * console, and then process.kill()s all of them. Worse, it does that inside a `.then()`
 * which resolves after the child has already been terminated, so if Windows reissued
 * the pid in the gap it enumerates a stranger's console and kills those processes
 * instead.
 *
 * That is not theoretical. It killed unrelated Claude Code sessions on this machine
 * during development, under exactly the process churn that makes pid reuse likely.
 *
 * `taskkill /T` is scoped to one pid and its descendants, which is the blast radius we
 * actually want: the session's own shell plus anything it started, such as MCP servers.
 * It runs synchronously so there is no window between deciding and acting.
 */
function killChildTree(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 5000,
      stdio: 'ignore',
    });
  } catch {
    // Non-zero exit just means the process had already gone.
  }
}

/**
 * Release the ConPTY plumbing node-pty leaves behind when a child exits by itself.
 *
 * node-pty runs a worker thread per pty to read the conout pipe, and only disposes it
 * from its error paths and from `kill()`. A child that exits normally, which is every
 * Claude session that ends the way it should, disposes nothing. Each one then strands a
 * worker plus its pipe, and a panel left running for a week accumulates one set per
 * session it has ever opened.
 *
 * This reaches into node-pty internals, so every step is best-effort. If a future
 * version renames these fields we quietly go back to leaking rather than crashing.
 */
function releasePtyResources(term) {
  const agent = term?._agent;
  const attempts = [
    () => agent?._conoutSocketWorker?.dispose?.(),
    () => agent?._inSocket?.destroy?.(),
    () => agent?._outSocket?.destroy?.(),
    () => term?._socket?.destroy?.(),
  ];
  for (const attempt of attempts) {
    try {
      attempt();
    } catch {
      // Best effort by design.
    }
  }
}

/** How much history a joining client receives along with the current screen. */
export const SNAPSHOT_SCROLLBACK = 1200;

/**
 * One child process under a real pseudo-terminal, plus a server-side mirror of what
 * its screen currently looks like.
 *
 * The mirror is the reason a late joiner sees a correct screen. Replaying raw bytes
 * would mangle Claude Code's in-place redraws, so instead the server keeps a headless
 * xterm fed by the same stream and serialises it on demand. Both this terminal and the
 * browser one run the unicode11 addon so their character widths agree; otherwise
 * wrapping in the snapshot diverges from wrapping in the live stream.
 */
export class Session extends EventEmitter {
  constructor({
    id,
    label,
    cwd,
    file,
    args = [],
    cols = 120,
    rows = 30,
    env = process.env,
    scrollback = DEFAULT_SCROLLBACK,
    meta = {},
  }) {
    super();

    this.id = id;
    this.label = label;
    this.cwd = cwd;
    this.file = file;
    this.args = args;
    this.env = env;
    this.meta = meta;

    this.cols = cols;
    this.rows = rows;

    this.alive = false;
    this.destroyed = false;
    this.exitCode = null;
    this.startedAt = null;
    this.lastActivityAt = null;
    this.pty = null;

    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
  }

  start() {
    if (this.pty || this.destroyed) return this;

    this.pty = pty.spawn(this.file, this.args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: this.env,
      useConpty: true,
    });

    this.alive = true;
    this.startedAt = Date.now();
    this.lastActivityAt = this.startedAt;

    this.pty.onData((data) => {
      this.lastActivityAt = Date.now();
      this.term.write(data);
      this.emit('data', data);
    });

    this.pty.onExit(({ exitCode }) => {
      const dying = this.pty;
      this.alive = false;
      this.exitCode = exitCode;
      this.pty = null;

      releasePtyResources(dying);

      this.emit('exit', exitCode);
    });

    return this;
  }

  write(data) {
    if (!this.alive || !this.pty) return false;
    this.lastActivityAt = Date.now();
    this.pty.write(data);
    return true;
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    try {
      this.term.resize(cols, rows);
    } catch {
      // A disposed mirror is not a reason to fail the caller.
    }
    if (!this.alive || !this.pty) return false;
    try {
      this.pty.resize(cols, rows);
    } catch {
      return false;
    }
    return true;
  }

  /**
   * The current screen, ready to hand a joining client. Awaits the mirror's write
   * queue first so output that arrived a moment ago is actually reflected.
   */
  async snapshot({ scrollback = SNAPSHOT_SCROLLBACK } = {}) {
    await new Promise((resolve) => this.term.write('', resolve));
    return this.serializer.serialize({ scrollback });
  }

  /** How long the child has been quiet. Feeds the idle fallback for attention alerts. */
  idleMs(now = Date.now()) {
    return this.lastActivityAt == null ? 0 : now - this.lastActivityAt;
  }

  /**
   * Stop the child but keep the screen mirror, so the final output stays readable in
   * the UI after Claude exits.
   */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;

    // Only act while node-pty still reports a live child. Once it has exited, `pty` is
    // null and the operating system may already have reissued that pid to somebody else.
    const term = this.pty;
    if (!term || !this.alive) return;

    if (process.platform !== 'win32') {
      // On Linux and macOS node-pty signals the child's own process group, which is
      // already scoped correctly. The hazard described on killChildTree is specific to
      // the Windows console model, so there is nothing to work around here.
      try {
        term.kill();
      } catch {
        // Already gone.
      }
      return;
    }

    killChildTree(term.pid);

    // Release the pseudoconsole directly. This is the safe half of node-pty's Windows
    // kill(); the half being avoided is the console enumeration described above.
    try {
      const agent = term._agent;
      agent?._ptyNative?.kill?.(agent._pty, agent._useConptyDll);
    } catch {
      // Already gone.
    }
  }

  /** Full teardown, for when the session leaves the manager entirely. */
  dispose() {
    this.destroy();
    try {
      this.term.dispose();
    } catch {
      // Already disposed.
    }
    this.removeAllListeners();
  }
}
