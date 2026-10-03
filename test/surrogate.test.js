/* Event-time permutation surrogate regression (§21).

   The previous returns-only surrogate shuffled a COPY OF THE SAME RETURN SERIES.
   Mean and standard deviation are permutation-invariant, so every surrogate
   statistic equalled the observed one and p degenerated to floating-point noise:
   a PERFECT edge returned p = 1.0, which made every OOS_SURVIVED / ROBUST /
   PAPER_ELIGIBLE board (and the `validated` early stop) unreachable.

   These tests plant a real edge and assert the null detects it, and feed a
   no-edge series and assert the null does not. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const OD = require('../public/discovery-engine.js');

function gaussFrom(rnd) {
  return () => {
    let u = 0, v = 0;
    while (!u) u = rnd();
    while (!v) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

// 40 (symbol, day) blocks × 60 rows; events are the first 5 rows of each block.
function build() {
  const nBlocks = 40, per = 60, n = nBlocks * per;
  const labels = new Float64Array(n), blocks = new Int32Array(n);
  const rnd = OD.rng(20240501);
  const gauss = gaussFrom(rnd);
  for (let b = 0; b < nBlocks; b++) {
    for (let j = 0; j < per; j++) {
      const i = b * per + j;
      labels[i] = gauss();
      blocks[i] = b;
    }
  }
  // planted edge: sparse events whose labels are strongly positive
  const planted = new Uint8Array(n);
  for (let b = 0; b < nBlocks; b++) {
    for (let j = 0; j < 5; j++) {
      const i = b * per + j;
      labels[i] = 6 + gauss() * 0.2;
      planted[i] = 1;
    }
  }
  // no-edge: random events over the untouched noise labels
  const noedge = new Uint8Array(n);
  const idx = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
  for (let k = 0; k < 200; k++) noedge[idx[k]] = 1;
  return { n, labels, blocks, planted, noedge };
}

test('surrogateMaskP: planted edge rejected, no-edge not (mean stat)', () => {
  const { labels, blocks, planted, noedge } = build();
  const edge = OD.surrogateMaskP(planted, labels, blocks, 200, 42, { stat: 'mean' });
  assert.equal(edge.nEvents, 200);
  assert.ok(edge.p < 0.05, `planted edge must clear p<0.05, got p=${edge.p}`);
  assert.ok(edge.obs > 5 && edge.nullMean < 0.5, `obs=${edge.obs} nullMean=${edge.nullMean}`);
  assert.ok(edge.observedPercentile > 95, `percentile=${edge.observedPercentile}`);
  const plain = OD.surrogateMaskP(noedge, labels, blocks, 200, 42, { stat: 'mean' });
  assert.ok(plain.p > 0.10, `no-edge data must not be rejected, got p=${plain.p}`);
  // p is a tail probability in (0,1], never the degenerate 1.0 constant
  assert.ok(edge.p > 0 && edge.p <= 1 && plain.p > 0 && plain.p <= 1);
});

test('surrogateMaskP: sharpe stat uses sample std (ddof=1) and detects the edge', () => {
  const { labels, blocks, planted, noedge } = build();
  const edge = OD.surrogateMaskP(planted, labels, blocks, 200, 7, { stat: 'sharpe' });
  assert.equal(edge.stat, 'sharpe');
  assert.ok(edge.p < 0.05, `planted edge sharpe p=${edge.p}`);
  const plain = OD.surrogateMaskP(noedge, labels, blocks, 200, 7, { stat: 'sharpe' });
  assert.ok(plain.p > 0.10, `no-edge sharpe p=${plain.p}`);
});

test('surrogateMaskP: deterministic, thin refused, misaligned arrays throw', () => {
  const { labels, blocks, planted } = build();
  const a = OD.surrogateMaskP(planted, labels, blocks, 100, 5);
  const b = OD.surrogateMaskP(planted, labels, blocks, 100, 5);
  assert.deepEqual(a, b, 'seeded deterministic');
  const thin = new Uint8Array(labels.length);
  for (let i = 0; i < 9; i++) thin[i] = 1;
  const t = OD.surrogateMaskP(thin, labels, blocks, 100, 5);
  assert.ok(Number.isNaN(t.p), 'fewer than 10 events -> p = NaN');
  assert.equal(t.nEvents, 9);
  assert.throws(() => OD.surrogateMaskP(new Uint8Array(3), labels, blocks, 10, 1), /length mismatch/);
  assert.throws(() => OD.surrogateMaskP(thin, labels, new Int32Array(3), 10, 1), /aligned/);
});

test('surrogateP is loudly deprecated (returns-only null is impossible)', () => {
  const r = OD.surrogateP([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 50, 1);
  assert.equal(r.deprecated, true);
  assert.ok(Number.isNaN(r.p));
  assert.ok(Number.isNaN(r.obs));
  assert.match(r.note, /surrogateMaskP/);
});
