import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { negotiateSize, MIN_COLS, MIN_ROWS } from '../src/size.js';

const FALLBACK = { cols: 120, rows: 30 };

const client = (over) => ({ id: 'x', label: 'x', cols: 80, rows: 24, wantsResize: true, ...over });

describe('negotiateSize()', () => {
  test('falls back to the last known size when nobody is attached', () => {
    const out = negotiateSize([], FALLBACK);
    assert.equal(out.cols, 120);
    assert.equal(out.rows, 30);
  });

  test('adopts the size of a single resizing client', () => {
    const out = negotiateSize([client({ label: 'desk', cols: 140, rows: 44 })], FALLBACK);
    assert.equal(out.cols, 140);
    assert.equal(out.rows, 44);
    assert.equal(out.by, 'desk');
  });

  test('takes the smallest size so no client sees a truncated screen', () => {
    const out = negotiateSize(
      [
        client({ id: 'a', label: 'desk', cols: 200, rows: 50 }),
        client({ id: 'b', label: 'laptop', cols: 100, rows: 30 }),
      ],
      FALLBACK,
    );
    assert.equal(out.cols, 100);
    assert.equal(out.rows, 30);
    assert.equal(out.by, 'laptop');
  });

  test('a phone that opted out of resizing does not shrink the terminal', () => {
    const out = negotiateSize(
      [
        client({ id: 'a', label: 'desk', cols: 160, rows: 40 }),
        client({ id: 'b', label: 'phone', cols: 40, rows: 20, wantsResize: false }),
      ],
      FALLBACK,
    );
    assert.equal(out.cols, 160);
    assert.equal(out.rows, 40);
    assert.equal(out.by, 'desk');
  });

  test('keeps the previous size when every attached client opted out', () => {
    const out = negotiateSize([client({ label: 'phone', cols: 40, rows: 20, wantsResize: false })], FALLBACK);
    assert.equal(out.cols, 120);
    assert.equal(out.rows, 30);
  });

  test('takes the minimum of each dimension independently', () => {
    const out = negotiateSize(
      [
        client({ id: 'a', label: 'tall', cols: 200, rows: 24 }),
        client({ id: 'b', label: 'wide', cols: 80, rows: 60 }),
      ],
      FALLBACK,
    );
    assert.equal(out.cols, 80);
    assert.equal(out.rows, 24);
  });

  test('attributes the result to whoever constrains the width', () => {
    const out = negotiateSize(
      [
        client({ id: 'a', label: 'tall', cols: 200, rows: 24 }),
        client({ id: 'b', label: 'wide', cols: 80, rows: 60 }),
      ],
      FALLBACK,
    );
    assert.equal(out.by, 'wide');
  });

  test('clamps absurdly small clients to a usable floor', () => {
    const out = negotiateSize([client({ label: 'tiny', cols: 2, rows: 1 })], FALLBACK);
    assert.equal(out.cols, MIN_COLS);
    assert.equal(out.rows, MIN_ROWS);
  });

  test('ignores clients reporting a non-numeric or zero size', () => {
    const out = negotiateSize(
      [
        client({ id: 'a', label: 'desk', cols: 100, rows: 30 }),
        client({ id: 'b', label: 'broken', cols: 0, rows: NaN }),
      ],
      FALLBACK,
    );
    assert.equal(out.cols, 100);
    assert.equal(out.rows, 30);
  });

  test('rounds fractional sizes down to whole cells', () => {
    const out = negotiateSize([client({ label: 'desk', cols: 100.7, rows: 30.9 })], FALLBACK);
    assert.equal(out.cols, 100);
    assert.equal(out.rows, 30);
  });
});
