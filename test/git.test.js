import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parsePorcelain } from '../src/git.js';

/** `git status --porcelain=v1 -z` emits NUL-separated records with no quoting. */
const z = (...records) => records.join('\u0000') + '\u0000';

describe('parsePorcelain()', () => {
  test('returns nothing for a clean tree', () => {
    assert.deepEqual(parsePorcelain(''), []);
  });

  test('reads a file modified in the worktree', () => {
    const [entry] = parsePorcelain(z(' M src/main.js'));
    assert.equal(entry.path, 'src/main.js');
    assert.equal(entry.status, 'modified');
    assert.equal(entry.staged, false);
  });

  test('reads a staged addition', () => {
    const [entry] = parsePorcelain(z('A  new.txt'));
    assert.equal(entry.path, 'new.txt');
    assert.equal(entry.status, 'added');
    assert.equal(entry.staged, true);
  });

  test('reads an untracked file', () => {
    const [entry] = parsePorcelain(z('?? scratch.log'));
    assert.equal(entry.path, 'scratch.log');
    assert.equal(entry.status, 'untracked');
  });

  test('reads a deletion', () => {
    const [entry] = parsePorcelain(z(' D gone.txt'));
    assert.equal(entry.status, 'deleted');
  });

  test('reads a rename and keeps the original name', () => {
    // In -z form a rename spends two records: the new path, then the old one.
    const [entry] = parsePorcelain(z('R  new-name.js', 'old-name.js'));
    assert.equal(entry.status, 'renamed');
    assert.equal(entry.path, 'new-name.js');
    assert.equal(entry.renamedFrom, 'old-name.js');
  });

  test('does not mistake the rename source for its own entry', () => {
    assert.equal(parsePorcelain(z('R  new-name.js', 'old-name.js')).length, 1);
  });

  test('reads a merge conflict', () => {
    const [entry] = parsePorcelain(z('UU conflicted.js'));
    assert.equal(entry.status, 'conflicted');
  });

  test('keeps paths containing spaces intact, which is why -z is used', () => {
    const [entry] = parsePorcelain(z(' M src/my file with spaces.js'));
    assert.equal(entry.path, 'src/my file with spaces.js');
  });

  test('reads several entries in order', () => {
    const entries = parsePorcelain(z(' M a.js', 'A  b.js', '?? c.js'));
    assert.deepEqual(entries.map((e) => e.path), ['a.js', 'b.js', 'c.js']);
  });

  test('marks a file that is both staged and modified', () => {
    const [entry] = parsePorcelain(z('MM half-staged.js'));
    assert.equal(entry.staged, true);
    assert.equal(entry.status, 'modified');
  });

  test('ignores a trailing empty record', () => {
    assert.equal(parsePorcelain(' M a.js\u0000\u0000').length, 1);
  });
});
