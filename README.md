# Porthole

Drive and share your local Claude Code sessions from a browser, over Tailscale.

A window into a machine that is under way somewhere else. Walk away from your desk and
keep steering the session from your phone, or send a friend a link and work on it
together.

```
  npm install
  npm start
```

That prints an admin link. Open it.

---

## What it actually is

The page shows the **real Claude Code terminal**, not a chat imitation of one. It is
xterm.js attached to a genuine pseudo-terminal on your machine, so every feature works
with nothing reimplemented: slash commands, plan mode, permission prompts, `/model`,
todo lists, the status line. It cannot drift out of date when Claude Code updates,
because there is nothing to keep in sync.

Several browsers can attach to the same session at once and all see identical output.

## Getting to it from elsewhere

Porthole binds to your Tailscale address by default, discovered automatically. It does
not listen on every interface unless you ask it to with `--all-interfaces`, and says so
loudly when you do.

For HTTPS, which unlocks real notifications, background push and clipboard access:

```
  npm run tailscale:serve
```

That fronts the panel with a genuine certificate on your `ts.net` name.

## Sharing

Three roles. Everything is enforced on the server; the browser hides controls it lacks
as a courtesy, never as a control.

| Role | Can |
| --- | --- |
| `admin` | everything, including starting and stopping sessions and minting invites |
| `control` | attach and type into existing sessions |
| `view` | watch only. Keystrokes are dropped server side |

```
  npm run invite -- --role view --label alice
  npm run invite -- --role control --label bob
  node bin/porthole.mjs invites          # list them
  node bin/porthole.mjs revoke <id>      # revoke one
```

New invites default to `view`, because sharing a terminal and handing over a shell are
different decisions.

**Say the quiet part out loud:** anyone holding a `control` link can run commands on
this machine as you. Give friends `view` unless you mean otherwise.

## Sessions

Three ways in:

- **Start one** from the panel, in any folder.
- **Resume** a past conversation. Porthole reads Claude Code's own logs and lists what
  you were working on, by name.
- **Reattach.** Sessions outlive browsers. Close every tab, walk away, come back on your
  phone; it is still running.

A session you started by hand in a terminal cannot be adopted by another program, so for
those, use resume.

## On a phone

The key bar covers what a terminal needs and a soft keyboard does not offer: `esc`,
`tab`, arrows, `shift-tab`, `ctrl-c`, `/`, `enter`. There is a normal text box for
typing a whole prompt, which beats poking at a terminal with a thumb.

Sizing is the interesting part. One terminal, several screens of different sizes. Alone
on a session, your phone sizes it to fit itself. With a desktop also watching, the phone
stands down and scales instead, so arriving on a phone never squeezes someone else's
session down to forty columns. The `fit` button overrides either way.

## Working together

By default anyone with `control` can type, which is what two people talking to each
other actually want. When that gets crowded, **take the helm**: you type, everyone else
sees who is driving and can ask for it. An admin can always seize it, so a session
cannot stay locked by someone who wandered off.

## Knowing when it wants you

Porthole wires Claude Code's own `Notification` and `Stop` hooks, so it is told when a
session needs you rather than guessing by watching the screen.

Alerts tier by what the browser allows. Over plain HTTP: a banner, a tab-title flash, a
chime, and a badge on the session. Over HTTPS: real notifications, and push even when
the tab is closed.

## Files and changes

Browse the session's folder and read its `git diff` from the page, without a terminal.
Confined to that folder: the jail resolves links before deciding, so a junction pointing
elsewhere does not escape it. Viewers get terminal only unless an admin opts them in.

## Requirements

Node 20.11 or newer, and Claude Code on your PATH. Windows, Linux and macOS.

There is **no build step**. No bundler, no transpiler. `npm install` then `npm start`.

## Where things live

Secrets live in `~/.porthole/`, outside the repo, so they cannot be committed by
accident.

```
bin/porthole.mjs     start, invite, invites, revoke, ls, tailscale-serve
src/session.js       one pty plus a server-side mirror of its screen
src/session-manager  every session and client, where roles and the helm are enforced
src/ws.js            the client contract: protocol v1
src/history.js       reading Claude Code's logs for resume
public/              the panel
```

## Notes for anyone extending it

**A late joiner gets a screen, not a recording.** The server keeps a headless terminal
mirroring each session and serialises it on demand. Replaying raw bytes would mangle the
in-place redraws that Claude Code's interface performs.

**The protocol is the whole contract.** A JSON control channel plus binary frames for
terminal output, versioned, with bearer-token auth as an alternative to the cookie. A
native mobile client is meant to be additive rather than a rewrite.

**Killing a session kills that session.** Not, as node-pty would have it on Windows,
every process that happens to share a console with it.
