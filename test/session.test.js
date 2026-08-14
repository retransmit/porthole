import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { Session } from '../src/session.js';

/** Snapshots carry SGR colour codes. Strip them before matching on text. */
const plain = (s) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '');

const nodeSession = (script, over = {}) =>
  new Session({
    id: 's-test',
    label: 'probe',
    cwd: process.cwd(),
    file: process.execPath,
    args: ['-e', script],
    cols: 80,
    rows: 24,
    ...over,
  });

describe('Session', () => {
  test('streams child output to data listeners', async (t) => {
    const s = nodeSession('console.log("hello-porthole")');
    t.after(() => s.destroy());

    const chunks = [];
    s.on('data', (d) => chunks.push(d));
    const exited = once(s, 'exit');
    s.start();
    await exited;

    assert.match(chunks.join(''), /hello-porthole/);
  });

  test('reports the child exit code', async (t) => {
    const s = nodeSession('process.exit(3)');
    t.after(() => s.destroy());

    const exited = once(s, 'exit');
    s.start();
    const [code] = await exited;

    assert.equal(code, 3);
  });

  test('mirrors output into a screen snapshot a late joiner can replay', async (t) => {
    const s = nodeSession('console.log("late-joiner-sees-this")');
    t.after(() => s.destroy());

    const exited = once(s, 'exit');
    s.start();
    await exited;

    assert.match(plain(await s.snapshot()), /late-joiner-sees-this/);
  });

  test('the snapshot reflects the final screen, not every byte ever written', async (t) => {
    // A program that clears the screen should not leave its pre-clear output in the
    // snapshot. This is exactly what a raw byte replay would get wrong.
    const s = nodeSession('process.stdout.write("SHOULD-BE-GONE\\r\\n\\x1b[2J\\x1b[H"); console.log("only-this-remains")');
    t.after(() => s.destroy());

    const exited = once(s, 'exit');
    s.start();
    await exited;

    const text = plain(await s.snapshot());
    assert.match(text, /only-this-remains/);
    assert.doesNotMatch(text, /SHOULD-BE-GONE/);
  });

  test('forwards written input to the child', async (t) => {
    const s = nodeSession(
      'process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => { if (d.includes("\\r")) { process.stdout.write("\\r\\nGOT[" + d.trim() + "]\\r\\n"); process.exit(0); } });',
    );
    t.after(() => s.destroy());

    let seen = '';
    s.on('data', (d) => {
      seen += d;
    });
    const exited = once(s, 'exit');
    s.start();

    await new Promise((r) => setTimeout(r, 400));
    s.write('ping\r');
    await exited;

    assert.match(seen, /GOT\[ping\]/);
  });

  test('tracks liveness across the child lifetime', async (t) => {
    const s = nodeSession('console.log("bye")');
    t.after(() => s.destroy());

    assert.equal(s.alive, false, 'not alive before start');
    const exited = once(s, 'exit');
    s.start();
    assert.equal(s.alive, true, 'alive once started');
    await exited;
    assert.equal(s.alive, false, 'not alive after exit');
  });

  test('resize updates the recorded geometry', async (t) => {
    const s = nodeSession('setTimeout(() => {}, 3000)');
    t.after(() => s.destroy());

    s.start();
    s.resize(100, 40);

    assert.equal(s.cols, 100);
    assert.equal(s.rows, 40);
  });

  test('destroy stops the child and marks the session dead', async (t) => {
    const s = nodeSession('setTimeout(() => {}, 30000)');
    t.after(() => s.destroy());

    const exited = once(s, 'exit');
    s.start();
    assert.equal(s.alive, true);
    s.destroy();
    await exited;

    assert.equal(s.alive, false);
  });

  test('releases the pty worker and pipe when a child exits on its own', async () => {
    // node-pty only disposes its per-pty conout worker from kill() and its error
    // paths. A child that exits normally strands a worker thread and a pipe, so a
    // panel left running for days accumulates one set per session ever opened.
    const messagePorts = () =>
      process.getActiveResourcesInfo().filter((r) => r === 'MessagePort').length;
    const settle = () => new Promise((r) => setTimeout(r, 750));

    // Earlier tests in this file are still tearing their ptys down, so let the
    // process quiesce before taking a baseline. Without this the baseline counts
    // other tests' pending cleanup and the comparison means nothing.
    await settle();
    const before = messagePorts();

    for (let i = 0; i < 3; i++) {
      const s = new Session({
        id: `leak-${i}`,
        label: `leak-${i}`,
        cwd: process.cwd(),
        file: process.execPath,
        args: ['-e', `console.log("leak-run-${i}")`],
        cols: 80,
        rows: 24,
      });
      const exited = once(s, 'exit');
      s.start();
      await exited;
      s.dispose();
    }

    await settle();

    // Leaking would leave these three sessions' workers alive, pushing the count
    // above the baseline. Anything at or below it means they were reclaimed.
    const after = messagePorts();
    assert.ok(
      after <= before,
      `three finished sessions should leave no worker threads behind, but the count went from ${before} to ${after}`,
    );
  });

  test('write and resize after exit are ignored rather than throwing', async (t) => {
    const s = nodeSession('console.log("done")');
    t.after(() => s.destroy());

    const exited = once(s, 'exit');
    s.start();
    await exited;

    assert.doesNotThrow(() => s.write('ignored'));
    assert.doesNotThrow(() => s.resize(50, 20));
  });
});
