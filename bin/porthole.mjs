#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { defaultStateDir, loadConfig, mintInvite, revokeInvite, saveConfig } from '../src/config.js';
import { SessionManager } from '../src/session-manager.js';
import { buildClaudeArgs, resolveClaudePath, sanitiseEnv } from '../src/claude.js';
import { buildHookSettings, removeHookSettings, writeHookSettings } from '../src/hooks.js';
import { createHttpServer } from '../src/http.js';
import { attachWebSocket } from '../src/ws.js';
import { Notifier } from '../src/notify.js';
import { buildUrl, chooseBindHost, runTailscale, tailscaleCandidates, tailscaleIPv4, tailscaleSelf } from '../src/net.js';
import { listSessions } from '../src/history.js';
import { buildPairingUri, mintPairingCode, PAIRING_TTL_MS } from '../src/pairing.js';
import QRCode from 'qrcode';

const args = process.argv.slice(2);
const command = args[0] ?? 'start';

const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const stateDir = flag('state', defaultStateDir());
const config = loadConfig(stateDir);

const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (msg) => console.log(`\x1b[2m${stamp()}\x1b[0m ${msg}`);

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

async function start() {
  const port = Number(flag('port', process.env.PORTHOLE_PORT ?? 7317));
  const claudePath = resolveClaudePath({ override: flag('claude') });

  const [tailscaleIp, self] = await Promise.all([tailscaleIPv4(), tailscaleSelf()]);
  const bind = chooseBindHost({
    explicitHost: flag('host'),
    tailscaleIp,
    allowAll: has('all-interfaces'),
  });

  // Regenerated every run. Hooks are launched by Claude Code, not by us, so this is
  // the only thing separating a genuine attention event from anything else that can
  // reach the port.
  const hookToken = crypto.randomBytes(24).toString('hex');

  // Hooks run on this machine but must reach the address we actually bound, not an
  // assumed loopback: binding to the tailnet address means nothing is listening on
  // 127.0.0.1. A wildcard bind is the one case where loopback is the right dial-back.
  const wildcard = bind.host === '0.0.0.0' || bind.host === '::';
  const hookHost = wildcard ? '127.0.0.1' : bind.host;
  const localEndpoint = `http://${hookHost.includes(':') ? `[${hookHost}]` : hookHost}:${port}/hook/attention`;

  const manager = new SessionManager({ flags: () => ({ viewersCanBrowseFiles: config.viewersCanBrowseFiles }) });

  const notifier = new Notifier({ config, persist: () => saveConfig(stateDir, config), log });
  saveConfig(stateDir, config);

  async function createSession({ cwd, label, resumeId = null }) {
    const target = path.resolve(cwd ?? process.cwd());
    if (!fs.existsSync(target)) throw new Error(`folder does not exist: ${target}`);

    const id = resumeId ?? crypto.randomUUID();
    const settingsPath = await writeHookSettings(
      stateDir,
      id,
      buildHookSettings({ endpoint: localEndpoint, hookToken }),
    );

    const rec = manager.create({
      id,
      cwd: target,
      label: label || path.basename(target),
      resumeId,
      file: claudePath,
      args: buildClaudeArgs({ sessionId: resumeId ? null : id, resumeId, settingsPath }),
      env: { ...sanitiseEnv(process.env), PORTHOLE: '1' },
    });

    rec.session.once('exit', () => removeHookSettings(stateDir, id));
    return rec;
  }

  const publicHost = self?.dnsName ?? bind.host;

  // Origins a handshake may legitimately come from. The tailnet name is included
  // because `tailscale serve` terminates TLS in front of us and the Host header it
  // forwards need not match the name the browser used.
  const tailnetName = self?.dnsName?.replace(/\.$/, '') ?? null;
  const allowedOrigins = [
    tailnetName,
    tailnetName ? `${tailnetName}:${port}` : null,
    `${bind.host}:${port}`,
    ...String(flag('allow-origin', '')).split(',').map((s) => s.trim()).filter(Boolean),
  ].filter(Boolean);
  const inviteUrl = (token) =>
    buildUrl({ host: bind.host, port, dnsName: bind.reason === 'tailscale' ? self?.dnsName : null, token });

  const server = createHttpServer({
    config,
    stateDir,
    manager,
    notifier,
    hookToken,
    log,
    allowedOrigins,
    options: { createSession, inviteUrl, publicUrl: publicHost },
  });

  attachWebSocket({
    server,
    config,
    manager,
    log,
    allowedOrigins,
    stateDir,
    flags: () => ({ viewersCanBrowseFiles: config.viewersCanBrowseFiles }),
  });

  server.listen(port, bind.host, () => {
    const base = buildUrl({ host: bind.host, port, dnsName: bind.reason === 'tailscale' ? self?.dnsName : null });
    console.log('');
    console.log(`  ${bold('Porthole')} ${dim('is listening')}`);
    console.log('');
    console.log(`  ${dim('admin')}   ${cyan(`${base}/?t=${config.adminToken}`)}`);
    console.log(`  ${dim('bind')}    ${bind.host}:${port} ${dim(`(${bind.reason})`)}`);
    if (self?.dnsName) console.log(`  ${dim('tailnet')} ${self.dnsName.replace(/\.$/, '')}`);
    console.log(`  ${dim('claude')}  ${claudePath}`);
    console.log(`  ${dim('state')}   ${stateDir}`);
    console.log('');
    if (bind.exposed) {
      console.log(`  ${yellow('!')} Listening on every interface, not just the tailnet.`);
      console.log(`    ${dim('Anyone who can reach this port and holds a control link can run commands as you.')}`);
      console.log('');
    }
    console.log(`  ${dim('Share view-only:')} npm run invite -- --role view --label alice`);
    console.log('');
  });

  const shutdown = () => {
    console.log('');
    log('shutting down, stopping sessions');
    manager.killAll();
    server.close();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function invite() {
  const role = flag('role', 'view');
  const label = flag('label', 'guest');
  try {
    const created = mintInvite(config, { role, label });
    saveConfig(stateDir, config);
    const port = Number(flag('port', process.env.PORTHOLE_PORT ?? 7317));
    console.log('');
    console.log(`  ${bold(created.role)} invite for ${bold(created.label)}  ${dim(`id ${created.id}`)}`);
    console.log(`  ${dim('token')} ${created.token}`);
    console.log('');
    console.log(`  ${dim('Append it to your panel address, for example:')}`);
    console.log(`  ${cyan(`http://<your-tailnet-name>:${port}/?t=${created.token}`)}`);
    console.log('');
    if (created.role === 'control') {
      console.log(`  ${yellow('!')} A control invite can run commands on this machine as you.`);
      console.log('');
    }
  } catch (err) {
    console.error(`could not mint invite: ${err.message}`);
    process.exit(1);
  }
}

async function pair() {
  const role = flag('role', 'control');
  const label = flag('label', 'phone');
  const port = Number(flag('port', process.env.PORTHOLE_PORT ?? 7317));

  const [ip, self] = await Promise.all([tailscaleIPv4(), tailscaleSelf()]);
  const host = flag('host') ?? self?.dnsName?.replace(/\.$/, '') ?? ip ?? '127.0.0.1';

  let minted;
  try {
    minted = mintPairingCode(config, { role, label, canCreate: has('can-create') });
  } catch (err) {
    console.error(`could not create a pairing code: ${err.message}`);
    process.exit(1);
  }
  saveConfig(stateDir, config);

  const uri = buildPairingUri({ host, port, code: minted.code, name: self?.hostName ?? host });

  console.log('');
  console.log(await QRCode.toString(uri, { type: 'terminal', small: true }));
  console.log(`  Scan this in the Porthole app to pair as ${bold(minted.role)}.`);
  console.log('');
  console.log(`  ${dim('code')}  ${bold(minted.code)}   ${dim('(if the camera will not focus)')}`);
  console.log(`  ${dim('panel')} ${host}:${port}`);
  console.log(`  ${dim('valid')} ${PAIRING_TTL_MS / 60000} minutes, one use only`);
  if (minted.canCreate) console.log(`  ${dim('extra')} may start and resume sessions`);
  console.log('');
  if (minted.role === 'control') {
    console.log(`  ${yellow('!')} A control pairing can run commands on this machine as you.`);
    console.log('');
  }
}

function invites() {
  if (!config.invites.length) return console.log('no invites yet');
  for (const i of config.invites) {
    const state = i.revoked ? 'revoked' : i.role;
    console.log(`${i.id}  ${String(state).padEnd(8)}  ${i.label}`);
  }
}

function revoke() {
  const id = args[1];
  if (!id) {
    console.error('usage: porthole revoke <invite-id>');
    process.exit(1);
  }
  const ok = revokeInvite(config, id);
  if (ok) saveConfig(stateDir, config);
  console.log(ok ? `revoked ${id}` : `no invite with id ${id}`);
}

async function ls() {
  const sessions = await listSessions({ limit: Number(flag('limit', 25)) });
  if (!sessions.length) return console.log('no past sessions found');
  for (const s of sessions) {
    const when = new Date(s.lastActivityAt).toISOString().slice(0, 16).replace('T', ' ');
    const size = `${Math.round(s.sizeBytes / 1024)}KB`.padStart(8);
    console.log(`${when}  ${size}  ${(s.cwd ?? '(unknown folder)').padEnd(40)}  ${s.title}`);
  }
}

async function tailscaleServe() {
  const port = Number(flag('port', process.env.PORTHOLE_PORT ?? 7317));
  console.log(`asking tailscale to front http://127.0.0.1:${port} with https`);

  // Goes through the same discovery the panel uses, so this works on a Mac where the
  // binary lives inside the app bundle rather than on PATH.
  const result = await runTailscale(['serve', '--bg', `http://127.0.0.1:${port}`]);

  if (!result.ok) {
    console.error(`tailscale serve failed: ${result.stderr || result.error?.message}`);
    console.error('checked: ' + tailscaleCandidates().join(', '));
    console.error('you may also need to enable HTTPS for your tailnet in the admin console');
    process.exit(1);
  }

  console.log(result.stdout || result.stderr);
  console.log('');
  console.log('https unlocks real notifications, web push and clipboard access.');
  console.log('undo with: tailscale serve --https=443 off');
}

function help() {
  console.log(`
  ${bold('porthole')} - drive and share local Claude Code sessions from a browser

  ${bold('start')}                  start the panel
    --port <n>           default 7317
    --host <addr>        override the bind address
    --all-interfaces     listen everywhere, not just the tailnet
    --claude <path>      path to the claude executable

  ${bold('invite')}                 mint a shareable link token
    --role view|control  default view
    --label <name>       who it is for

  ${bold('pair')}                   show a QR to pair the Android app
    --role view|control  default control
    --label <name>       which device it is

  ${bold('invites')}                list invites
  ${bold('revoke')} <id>            revoke one
  ${bold('ls')}                     list resumable past sessions
  ${bold('tailscale-serve')}        front the panel with https via tailscale
`);
}

const commands = { start, invite, invites, revoke, ls, pair, 'tailscale-serve': tailscaleServe, help };

const handler = commands[command];
if (!handler) {
  console.error(`unknown command: ${command}`);
  help();
  process.exit(1);
}

await handler();
