import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildClaudeArgs, resolveClaudePath } from '../src/claude.js';

const UUID = '11111111-2222-3333-4444-555555555555';

describe('buildClaudeArgs()', () => {
  test('pins a new session to an id we minted, which is what makes resume reliable', () => {
    assert.deepEqual(buildClaudeArgs({ sessionId: UUID }), ['--session-id', UUID]);
  });

  test('resumes by id', () => {
    assert.deepEqual(buildClaudeArgs({ resumeId: UUID }), ['--resume', UUID]);
  });

  test('never passes both --resume and --session-id', () => {
    const args = buildClaudeArgs({ sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', resumeId: UUID });
    assert.deepEqual(args, ['--resume', UUID]);
  });

  test('wires a settings file when one is supplied', () => {
    const args = buildClaudeArgs({ sessionId: UUID, settingsPath: 'C:/state/hooks.json' });
    assert.deepEqual(args, ['--session-id', UUID, '--settings', 'C:/state/hooks.json']);
  });

  test('appends extra arguments last so they can override', () => {
    const args = buildClaudeArgs({ sessionId: UUID, extraArgs: ['--model', 'opus'] });
    assert.deepEqual(args, ['--session-id', UUID, '--model', 'opus']);
  });

  test('rejects a session id that is not a uuid, which claude would refuse anyway', () => {
    assert.throws(() => buildClaudeArgs({ sessionId: 'not-a-uuid' }), /uuid/i);
  });

  test('rejects a resume id that is not a uuid', () => {
    assert.throws(() => buildClaudeArgs({ resumeId: 'nope' }), /uuid/i);
  });

  test('requires one of session id or resume id', () => {
    assert.throws(() => buildClaudeArgs({}), /session/i);
  });

  test('rejects extra arguments that are not strings', () => {
    assert.throws(() => buildClaudeArgs({ sessionId: UUID, extraArgs: [{ evil: true }] }), /string/i);
  });
});

describe('resolveClaudePath()', () => {
  test('prefers an explicit override', () => {
    assert.equal(resolveClaudePath({ override: 'C:/custom/claude.exe' }), 'C:/custom/claude.exe');
  });

  test('falls back to the PORTHOLE_CLAUDE_PATH environment variable', () => {
    assert.equal(resolveClaudePath({ env: { PORTHOLE_CLAUDE_PATH: 'C:/env/claude.exe' } }), 'C:/env/claude.exe');
  });

  test('an override beats the environment variable', () => {
    const got = resolveClaudePath({ override: 'C:/win.exe', env: { PORTHOLE_CLAUDE_PATH: 'C:/lose.exe' } });
    assert.equal(got, 'C:/win.exe');
  });

  test('falls back to a bare command name that the OS can look up on PATH', () => {
    const got = resolveClaudePath({ env: {} });
    assert.match(got, /claude/i);
  });

  // The panel is meant to run on Windows, Linux and macOS, so the platform has to be
  // injectable. Otherwise these branches are only ever exercised on whichever machine
  // happens to run the tests.
  test('asks for claude.exe on windows', () => {
    assert.equal(resolveClaudePath({ env: {}, platform: 'win32' }), 'claude.exe');
  });

  test('asks for plain claude on linux', () => {
    assert.equal(resolveClaudePath({ env: {}, platform: 'linux' }), 'claude');
  });

  test('asks for plain claude on macos', () => {
    assert.equal(resolveClaudePath({ env: {}, platform: 'darwin' }), 'claude');
  });
});
