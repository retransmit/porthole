import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveWithin, listDir, readTextFile } from '../src/files.js';

let root;
let outside;

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-fs-'));
  root = path.join(base, 'proj');
  outside = path.join(base, 'secrets');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'private.txt'), 'do not leak me');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'main.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(root, 'readme.md'), '# hi\n');
});

afterEach(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

describe('resolveWithin() jail', () => {
  test('resolves an ordinary relative path', () => {
    assert.equal(resolveWithin(root, 'src/main.js'), path.join(root, 'src', 'main.js'));
  });

  test('treats an empty path as the root itself', () => {
    assert.equal(resolveWithin(root, ''), path.resolve(root));
    assert.equal(resolveWithin(root, '.'), path.resolve(root));
  });

  test('accepts backslash separators on windows', (t) => {
    // On POSIX a backslash is a perfectly legal character in a filename, not a
    // separator, so "src\main.js" there names one file rather than two path segments.
    // Treating it as a separator would make a real file unreachable. It is not a jail
    // concern either way: "..\..\etc" on Linux is a strange name inside the root.
    if (process.platform !== 'win32') return t.skip('posix treats a backslash as a literal character');
    assert.equal(resolveWithin(root, 'src\\main.js'), path.join(root, 'src', 'main.js'));
  });

  test('normalises a path that dips out and back in', () => {
    assert.equal(resolveWithin(root, 'src/../readme.md'), path.join(root, 'readme.md'));
  });

  test('refuses a parent traversal', () => {
    assert.equal(resolveWithin(root, '..'), null);
    assert.equal(resolveWithin(root, '../secrets/private.txt'), null);
    assert.equal(resolveWithin(root, 'src/../../secrets/private.txt'), null);
  });

  test('refuses a deep traversal that lands back on disk root', () => {
    assert.equal(resolveWithin(root, '../../../../../../../../Windows/System32'), null);
  });

  test('refuses an absolute path outside the root', () => {
    assert.equal(resolveWithin(root, path.join(outside, 'private.txt')), null);
  });

  test('refuses a sibling directory that merely shares the root prefix', () => {
    // "C:\tmp\proj-evil" must not pass a naive startsWith("C:\tmp\proj") check.
    const sibling = `${root}-evil`;
    fs.mkdirSync(sibling, { recursive: true });
    assert.equal(resolveWithin(root, sibling), null);
  });

  test('refuses a path containing a null byte', () => {
    assert.equal(resolveWithin(root, 'src/main.js\u0000.png'), null);
  });

  test('matches case-insensitively on Windows so casing cannot smuggle an escape', (t) => {
    if (process.platform !== 'win32') return t.skip('windows-specific');
    assert.equal(resolveWithin(root.toUpperCase(), 'readme.md'), path.join(root.toUpperCase(), 'readme.md'));
  });

  test('refuses to follow a junction that points outside the root', (t) => {
    // Junctions need no elevation on Windows, unlike symlinks.
    const link = path.join(root, 'escape');
    try {
      if (process.platform === 'win32') {
        execFileSync('cmd', ['/c', 'mklink', '/J', link, outside], { stdio: 'ignore' });
      } else {
        fs.symlinkSync(outside, link, 'dir');
      }
    } catch {
      return t.skip('this environment does not allow creating links');
    }
    assert.equal(resolveWithin(root, 'escape/private.txt'), null);
  });

  test('still resolves a link that stays inside the root', (t) => {
    const target = path.join(root, 'src');
    const link = path.join(root, 'alias');
    try {
      if (process.platform === 'win32') {
        execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' });
      } else {
        fs.symlinkSync(target, link, 'dir');
      }
    } catch {
      return t.skip('this environment does not allow creating links');
    }
    assert.notEqual(resolveWithin(root, 'alias/main.js'), null);
  });
});

describe('listDir()', () => {
  test('lists entries with their type', async () => {
    const out = await listDir(root, '');
    const names = out.entries.map((e) => e.name).sort();
    assert.deepEqual(names, ['readme.md', 'src']);
    assert.equal(out.entries.find((e) => e.name === 'src').type, 'dir');
    assert.equal(out.entries.find((e) => e.name === 'readme.md').type, 'file');
  });

  test('sorts directories before files', async () => {
    fs.writeFileSync(path.join(root, 'aaa.txt'), 'a');
    const out = await listDir(root, '');
    assert.equal(out.entries[0].type, 'dir');
  });

  test('lists a subdirectory', async () => {
    const out = await listDir(root, 'src');
    assert.deepEqual(out.entries.map((e) => e.name), ['main.js']);
  });

  test('refuses to list outside the jail', async () => {
    await assert.rejects(() => listDir(root, '../secrets'), /outside|denied/i);
  });

  test('reports a missing directory as an error, not a crash', async () => {
    await assert.rejects(() => listDir(root, 'nope'), /not found|ENOENT/i);
  });
});

describe('readTextFile()', () => {
  test('reads a text file inside the jail', async () => {
    const out = await readTextFile(root, 'readme.md');
    assert.equal(out.text, '# hi\n');
    assert.equal(out.binary, false);
  });

  test('refuses to read outside the jail', async () => {
    await assert.rejects(() => readTextFile(root, '../secrets/private.txt'), /outside|denied/i);
  });

  test('flags a binary file instead of returning mojibake', async () => {
    fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
    const out = await readTextFile(root, 'blob.bin');
    assert.equal(out.binary, true);
    assert.equal(out.text, null);
  });

  test('truncates a file larger than the cap rather than loading it all', async () => {
    fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(5000));
    const out = await readTextFile(root, 'big.txt', { maxBytes: 1000 });
    assert.equal(out.truncated, true);
    assert.equal(out.text.length, 1000);
  });

  test('does not mark a small file as truncated', async () => {
    const out = await readTextFile(root, 'readme.md', { maxBytes: 1000 });
    assert.equal(out.truncated, false);
  });
});
