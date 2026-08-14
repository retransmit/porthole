/**
 * One PTY, many screens.
 *
 * The terminal is sized to the smallest screen among clients that asked to participate.
 * Clients that opt out (phones, by default) render the full grid scaled or scrolled
 * instead, so a phone joining never squeezes a desktop session down to forty columns.
 */

export const MIN_COLS = 20;
export const MIN_ROWS = 5;

const clamp = (value, min) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(min, n) : min;
};

const votes = (c) =>
  c?.wantsResize === true &&
  Number.isFinite(Number(c.cols)) &&
  Number.isFinite(Number(c.rows)) &&
  Number(c.cols) > 0 &&
  Number(c.rows) > 0;

/**
 * @param {Array<{id?: string, label?: string, cols: number, rows: number, wantsResize: boolean}>} clients
 * @param {{cols: number, rows: number}} fallback last agreed size, kept when nobody votes
 * @returns {{cols: number, rows: number, by: string|null}} `by` names whoever constrains the width
 */
export function negotiateSize(clients, fallback = { cols: 120, rows: 30 }) {
  const voters = (clients ?? []).filter(votes);

  if (voters.length === 0) {
    return { cols: clamp(fallback.cols, MIN_COLS), rows: clamp(fallback.rows, MIN_ROWS), by: null };
  }

  let cols = Infinity;
  let rows = Infinity;
  let by = null;

  for (const c of voters) {
    const cc = Math.floor(Number(c.cols));
    const rr = Math.floor(Number(c.rows));
    if (cc < cols) {
      cols = cc;
      by = c.label ?? c.id ?? null;
    }
    if (rr < rows) rows = rr;
  }

  return { cols: clamp(cols, MIN_COLS), rows: clamp(rows, MIN_ROWS), by };
}
