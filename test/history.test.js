import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readSessionMeta, listSessions, isSessionFile, LIVE_WINDOW_MS } from '../src/history.js';

/**
 * Resuming a conversation that is already running elsewhere starts a second process
 * writing the same transcript. The panel can see the sessions it started itself, but
 * not one you launched from a terminal, so freshness of the log is the only signal
 * available that somebody else is already in there.
 */
describe('detecting a session that is already running', () => {
  const recent = (o) => JSON.stringify(o) + '\n';

  test('flags a session whose log was written moments ago', () => {
    const now = Date.UTC(2026, 7, 14, 12, 0, 0);
    const file = writeSession('E--Programs-demo', UUID_A, [
      recent({ type: 'user', sessionId: UUID_A, cwd: 'E:\\demo', timestamp: new Date(now - 5_000).toISOString() }),
    ]);
    return readSessionMeta(file, { now }).then((meta) => {
      assert.equal(meta.likelyLive, true);
    });
  });

  test('does not flag a session last touched hours ago', () => {
    const now = Date.UTC(2026, 7, 14, 12, 0, 0);
    const file = writeSession('E--Programs-demo', UUID_A, [
      recent({ type: 'user', sessionId: UUID_A, cwd: 'E:\\demo', timestamp: new Date(now - 3 * 3600_000).toISOString() }),
    ]);
    return readSessionMeta(file, { now }).then((meta) => {
      assert.equal(meta.likelyLive, false);
    });
  });

  test('treats activity exactly at the edge of the window as stale', () => {
    const now = Date.UTC(2026, 7, 14, 12, 0, 0);
    const file = writeSession('E--Programs-demo', UUID_A, [
      recent({ type: 'user', sessionId: UUID_A, cwd: 'E:\\demo', timestamp: new Date(now - LIVE_WINDOW_MS - 1).toISOString() }),
    ]);
    return readSessionMeta(file, { now }).then((meta) => {
      assert.equal(meta.likelyLive, false);
    });
  });
});

let root;

const UUID_A = '11111111-2222-3333-4444-555555555555';
const UUID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const rec = (o) => JSON.stringify(o) + '\n';

function writeSession(projectDir, uuid, lines) {
  const dir = path.join(root, projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${uuid}.jsonl`);
  fs.writeFileSync(file, lines.join(''));
  return file;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-hist-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('isSessionFile()', () => {
  test('accepts a uuid-named jsonl file', () => {
    assert.equal(isSessionFile(`${UUID_A}.jsonl`), true);
  });

  test('rejects journal.jsonl, which sits in the same tree but is not a session', () => {
    assert.equal(isSessionFile('journal.jsonl'), false);
  });

  test('rejects non-jsonl files', () => {
    assert.equal(isSessionFile(`${UUID_A}.json`), false);
    assert.equal(isSessionFile('notes.txt'), false);
  });
});

describe('readSessionMeta()', () => {
  test('reads the session id and cwd out of the head', async () => {
    const file = writeSession('E--Programs-demo', UUID_A, [
      rec({ type: 'last-prompt', lastPrompt: 'hi', sessionId: UUID_A }),
      rec({ type: 'user', sessionId: UUID_A, cwd: 'E:\\Programs\\demo', timestamp: '2026-08-01T10:00:00.000Z' }),
    ]);

    const meta = await readSessionMeta(file);

    assert.equal(meta.sessionId, UUID_A);
    assert.equal(meta.cwd, 'E:\\Programs\\demo');
  });

  test('prefers the ai-title as the session name', async () => {
    const file = writeSession('E--Programs-demo', UUID_A, [
      rec({ type: 'user', sessionId: UUID_A, cwd: 'E:\\demo', timestamp: '2026-08-01T10:00:00.000Z' }),
      rec({ type: 'last-prompt', lastPrompt: 'some raw prompt text', sessionId: UUID_A }),
      rec({ type: 'ai-title', aiTitle: 'Refactor the parser', sessionId: UUID_A }),
    ]);

    assert.equal((await readSessionMeta(file)).title, 'Refactor the parser');
  });

  test('uses the most recent ai-title when the session was renamed', async () => {
    const file = writeSession('E--Programs-demo', UUID_A, [
      rec({ type: 'user', sessionId: UUID_A, cwd: 'E:\\demo', timestamp: '2026-08-01T10:00:00.000Z' }),
      rec({ type: 'ai-title', aiTitle: 'Old name', sessionId: UUID_A }),
      rec({ type: 'ai-title', aiTitle: 'Current name', sessionId: UUID_A }),
    ]);

    assert.equal((await readSessionMeta(file)).title, 'Current name');
  });

  test('falls back to the last prompt when there is no ai-title', async () => {
    const file = writeSession('E--Programs-demo', UUID_A, [
      rec({ type: 'user', sessionId: UUID_A, cwd: 'E:\\demo', timestamp: '2026-08-01T10:00:00.000Z' }),
      rec({ type: 'last-prompt', lastPrompt: 'make the tests pass', sessionId: UUID_A }),
    ]);

    assert.equal((await readSessionMeta(file)).title, 'make the tests pass');
  });

  test('falls back to a placeholder when the file names itself nothing', async () => {
    const file = writeSession('E--Programs-demo', UUID_A, [
      rec({ type: 'user', sessionId: UUID_A, cwd: 'E:\\demo', timestamp: '2026-08-01T10:00:00.000Z' }),
    ]);

    assert.equal((await readSessionMeta(file)).title, '(untitled)');
  });

  test('takes last activity from the newest timestamped record', async () => {
    const file = writeSession('E--Programs-demo', UUID_A, [
      rec({ type: 'user', sessionId: UUID_A, cwd: 'E:\\demo', timestamp: '2026-08-01T10:00:00.000Z' }),
      rec({ type: 'assistant', sessionId: UUID_A, cwd: 'E:\\demo', timestamp: '2026-08-02T12:30:00.000Z' }),
    ]);

    const meta = await readSessionMeta(file);
    assert.equal(new Date(meta.lastActivityAt).toISOString(), '2026-08-02T12:30:00.000Z');
  });

  test('reads only the head and tail, never the middle of a huge file', async () => {
    // A 487MB session exists on this machine. Reading one whole would stall the panel,
    // so the title in the middle must NOT win: only head and tail are ever scanned.
    const filler = rec({ type: 'assistant', sessionId: UUID_A, cwd: 'E:\\demo', timestamp: '2026-08-01T11:00:00.000Z', pad: 'x'.repeat(400) });
    const lines = [
      rec({ type: 'user', sessionId: UUID_A, cwd: 'E:\\demo', timestamp: '2026-08-01T10:00:00.000Z' }),
      rec({ type: 'ai-title', aiTitle: 'HEAD-TITLE', sessionId: UUID_A }),
      ...Array(600).fill(filler),
      rec({ type: 'ai-title', aiTitle: 'MIDDLE-TITLE-SHOULD-NOT-WIN', sessionId: UUID_A }),
      ...Array(600).fill(filler),
      rec({ type: 'ai-title', aiTitle: 'TAIL-TITLE', sessionId: UUID_A }),
      rec({ type: 'assistant', sessionId: UUID_A, cwd: 'E:\\demo', timestamp: '2026-08-03T09:00:00.000Z' }),
    ];
    const file = writeSession('E--Programs-demo', UUID_A, lines);
    assert.ok(fs.statSync(file).size > 400_000, 'fixture must exceed the head and tail windows combined');

    const meta = await readSessionMeta(file, { headBytes: 4096, tailBytes: 4096 });

    assert.equal(meta.title, 'TAIL-TITLE');
  });

  test('survives a partial json line at the start of the tail window', async () => {
    const long = rec({ type: 'assistant', sessionId: UUID_A, cwd: 'E:\\demo', timestamp: '2026-08-01T11:00:00.000Z', pad: 'y'.repeat(3000) });
    const file = writeSession('E--Programs-demo', UUID_A, [
      rec({ type: 'user', sessionId: UUID_A, cwd: 'E:\\demo', timestamp: '2026-08-01T10:00:00.000Z' }),
      long,
      rec({ type: 'ai-title', aiTitle: 'After the split', sessionId: UUID_A }),
    ]);

    // A 1KB tail window lands in the middle of the padded record above.
    const meta = await readSessionMeta(file, { headBytes: 512, tailBytes: 1024 });
    assert.equal(meta.title, 'After the split');
  });

  test('returns null cwd rather than guessing when the file never records one', async () => {
    const file = writeSession('E--Programs-claude-local-control-anywhere', UUID_A, [
      rec({ type: 'mode', mode: 'normal', sessionId: UUID_A }),
    ]);

    const meta = await readSessionMeta(file);
    assert.equal(meta.cwd, null, 'directory names are lossy, so guessing would be worse than admitting ignorance');
    assert.equal(meta.resumable, false);
  });

  test('marks a session resumable only when a cwd is known', async () => {
    const file = writeSession('E--Programs-demo', UUID_A, [
      rec({ type: 'user', sessionId: UUID_A, cwd: 'E:\\demo', timestamp: '2026-08-01T10:00:00.000Z' }),
    ]);
    assert.equal((await readSessionMeta(file)).resumable, true);
  });

  test('handles an empty file without throwing', async () => {
    const file = writeSession('E--Programs-demo', UUID_A, []);
    const meta = await readSessionMeta(file);
    assert.equal(meta.sessionId, UUID_A, 'the filename still identifies the session');
    assert.equal(meta.cwd, null);
  });

  test('handles a file of pure garbage without throwing', async () => {
    const file = writeSession('E--Programs-demo', UUID_A, ['not json at all\n', '{ broken\n']);
    const meta = await readSessionMeta(file);
    assert.equal(meta.title, '(untitled)');
  });
});

describe('listSessions()', () => {
  test('finds sessions across project directories', async () => {
    writeSession('E--Programs-one', UUID_A, [
      rec({ type: 'user', sessionId: UUID_A, cwd: 'E:\\Programs\\one', timestamp: '2026-08-01T10:00:00.000Z' }),
    ]);
    writeSession('E--Programs-two', UUID_B, [
      rec({ type: 'user', sessionId: UUID_B, cwd: 'E:\\Programs\\two', timestamp: '2026-08-02T10:00:00.000Z' }),
    ]);

    assert.equal((await listSessions({ projectsDir: root })).length, 2);
  });

  test('skips journal.jsonl and other non-session files in the same tree', async () => {
    writeSession('E--Programs-one', UUID_A, [
      rec({ type: 'user', sessionId: UUID_A, cwd: 'E:\\Programs\\one', timestamp: '2026-08-01T10:00:00.000Z' }),
    ]);
    fs.writeFileSync(path.join(root, 'E--Programs-one', 'journal.jsonl'), rec({ type: 'started' }));

    const found = await listSessions({ projectsDir: root });
    assert.equal(found.length, 1);
    assert.equal(found[0].sessionId, UUID_A);
  });

  test('sorts most recently active first', async () => {
    writeSession('E--Programs-old', UUID_A, [
      rec({ type: 'user', sessionId: UUID_A, cwd: 'E:\\old', timestamp: '2026-01-01T10:00:00.000Z' }),
    ]);
    writeSession('E--Programs-new', UUID_B, [
      rec({ type: 'user', sessionId: UUID_B, cwd: 'E:\\new', timestamp: '2026-08-01T10:00:00.000Z' }),
    ]);

    const found = await listSessions({ projectsDir: root });
    assert.equal(found[0].sessionId, UUID_B);
  });

  test('honours a limit', async () => {
    for (let i = 0; i < 5; i++) {
      const id = `0000000${i}-2222-3333-4444-555555555555`;
      writeSession(`E--p${i}`, id, [
        rec({ type: 'user', sessionId: id, cwd: `E:\\p${i}`, timestamp: `2026-08-0${i + 1}T10:00:00.000Z` }),
      ]);
    }
    assert.equal((await listSessions({ projectsDir: root, limit: 2 })).length, 2);
  });

  test('returns an empty list when the projects directory does not exist', async () => {
    assert.deepEqual(await listSessions({ projectsDir: path.join(root, 'missing') }), []);
  });
});
