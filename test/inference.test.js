/* XBOST trials-aware statistical inference tests (run: npm test).
   Pure functions only — no DOM, no data, no dependencies.

   These lock the multiple-testing correction that stops a 335,232-configuration
   grid search from reporting a lucky Sharpe as a validated edge:

     PSR : Phi( (sr - srBenchmark) * sqrt(T-1) / sqrt(1 - skew*sr + ((kurt-1)/4)*sr^2) )
     SR0 : sqrt(var) * ((1-γ)·Φ⁻¹(1-1/N) + γ·Φ⁻¹(1-1/(N·e)))
     DSR : PSR evaluated at srBenchmark = SR0
*/
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/engine.js');

// deterministic PRNG so every assertion is reproducible
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

test('probabilisticSharpe: strong edge > 0.99, zero-mean noise ≈ 0.5', () => {
  // sr = 0.2 per observation over T = 250 observations, normal moments:
  // denom = sqrt(1 + 0.5*0.04) = 1.00995; z = 0.2*sqrt(249)/denom ≈ 3.125.
  const strong = E.probabilisticSharpe(0.2, 250, 0, 3, 0);
  assert.ok(strong > 0.99, `strong edge PSR ${strong} must exceed 0.99`);
  assert.ok(strong <= 1, 'PSR is a probability');
  // zero-mean noise: sr = 0 → Phi(0) = 0.5 exactly (within the CDF's error)
  const noise = E.probabilisticSharpe(0, 250, 0, 3, 0);
  assert.ok(Math.abs(noise - 0.5) < 0.01, `zero-mean PSR ${noise} ≈ 0.5`);
  // and a small positive sr with a huge T must not be forced to 0.5
  const small = E.probabilisticSharpe(0.02, 5000, 0, 3, 0);
  assert.ok(small > 0.5 && small < 1, `small edge PSR ${small} in (0.5, 1)`);
  // benchmark > sr can never be significant
  const below = E.probabilisticSharpe(0.1, 250, 0, 3, 0.5);
  assert.ok(below < 0.5, 'PSR against a higher benchmark is < 0.5');
});

test('probabilisticSharpe: NaN guards for T < 2 and non-finite input', () => {
  assert.ok(Number.isNaN(E.probabilisticSharpe(0.2, 1, 0, 3, 0)), 'T = 1 → NaN');
  assert.ok(Number.isNaN(E.probabilisticSharpe(0.2, 0, 0, 3, 0)), 'T = 0 → NaN');
  assert.ok(Number.isNaN(E.probabilisticSharpe(0.2, NaN, 0, 3, 0)), 'T = NaN → NaN');
  assert.ok(Number.isNaN(E.probabilisticSharpe(0.2, Infinity, 0, 3, 0)), 'T = Infinity → NaN');
  assert.ok(Number.isNaN(E.probabilisticSharpe(NaN, 250, 0, 3, 0)), 'sr = NaN → NaN');
  assert.ok(Number.isNaN(E.probabilisticSharpe(0.2, 250, NaN, 3, 0)), 'skew = NaN → NaN');
  assert.ok(Number.isNaN(E.probabilisticSharpe(0.2, 250, 0, NaN, 0)), 'kurt = NaN → NaN');
  assert.ok(Number.isNaN(E.probabilisticSharpe(0.2, 250, 0, 3, NaN)), 'benchmark = NaN → NaN');
  // denom must be positive: skew*sr ≥ 1 + (kurt-1)/4*sr² → NaN, never a fake probability
  assert.ok(Number.isNaN(E.probabilisticSharpe(0.5, 250, 3, 3, 0)), 'non-positive denom → NaN');
  assert.ok(Number.isFinite(E.probabilisticSharpe(0.2, 2, 0, 3, 0)), 'T = 2 is the smallest valid sample');
});

test('expectedMaxSharpe: monotone in nTrials, sqrt(2 ln N)-ish magnitudes', () => {
  assert.ok(Number.isNaN(E.expectedMaxSharpe(1, 1)), 'nTrials < 2 → NaN (no maximum of one draw)');
  assert.ok(Number.isNaN(E.expectedMaxSharpe(0, 1)), 'nTrials = 0 → NaN');
  assert.ok(Number.isNaN(E.expectedMaxSharpe(NaN, 1)), 'nTrials = NaN → NaN');
  assert.ok(Number.isNaN(E.expectedMaxSharpe(100, -1)), 'negative variance → NaN');
  let prev = -Infinity;
  for (const n of [2, 5, 10, 42, 100, 1000, 10000, 100000, 335232, 1000000]) {
    const v = E.expectedMaxSharpe(n, 1);
    assert.ok(isFinite(v) && v > prev, `bar(${n}) = ${v} must increase (prev ${prev})`);
    prev = v;
    // sanity vs the classic sqrt(2 ln N) asymptotic (same order for N ≥ 42;
    // the closed form is deliberately below it because it is an exact E[max],
    // not the large-N approximation)
    if (n >= 42) {
      const asym = Math.sqrt(2 * Math.log(n));
      assert.ok(v > 0.5 * asym && v < asym + 0.6, `bar(${n}) = ${v} near sqrt(2 ln N) = ${asym}`);
    }
  }
  // the two headline magnitudes from the review
  const b42 = E.expectedMaxSharpe(42, 1);
  assert.ok(b42 > 1.8 && b42 < 2.3, `42 trials → 2.03-ish sigma, got ${b42}`);
  const b335 = E.expectedMaxSharpe(335232, 1);
  assert.ok(b335 > 4.2 && b335 < 4.9, `335,232 trials → 4.54-ish sigma, got ${b335}`);
  // variance scales as sqrt(var)
  assert.ok(Math.abs(E.expectedMaxSharpe(1000, 4) - 2 * E.expectedMaxSharpe(1000, 1)) < 1e-9, 'sqrt(var) scaling');
  // benchmarkSharpe(N) is exactly expectedMaxSharpe(N, 1)
  for (const n of [2, 42, 335232]) assert.equal(E.benchmarkSharpe(n), E.expectedMaxSharpe(n, 1));
});

test('deflatedSharpe: PASSES at N=1, FAILS at 335,232 (the core property)', () => {
  // A per-observation edge that is significant against 0 …
  const sr = 0.15, T = 250, skew = 0, kurt = 3;
  const psr = E.probabilisticSharpe(sr, T, skew, kurt, 0);
  assert.ok(psr > 0.95, `PSR vs 0 must pass (got ${psr})`);
  // … at a plausible trial dispersion (variance of the per-observation Sharpes)
  const varTrials = 0.01;
  const atN1 = E.deflatedSharpe(sr, T, skew, kurt, 1, varTrials);
  assert.ok(atN1.dsr > 0.95, `single trial must not be penalised (dsr ${atN1.dsr})`);
  assert.equal(atN1.sr0, 0, 'N = 1 → the null bar is 0');
  const big = E.deflatedSharpe(sr, T, skew, kurt, 335232, varTrials);
  assert.ok(big.dsr < 0.95, `335,232 trials must deflate away the edge (dsr ${big.dsr})`);
  assert.ok(big.sr0 > atN1.sr0, 'the bar grows with N');
  // same edge, monotone in N
  let prev = Infinity;
  for (const n of [2, 10, 100, 1000, 10000, 335232]) {
    const d = E.deflatedSharpe(sr, T, skew, kurt, n, varTrials);
    assert.ok(d.dsr < prev, `dsr must shrink with N (N=${n}: ${d.dsr} vs ${prev})`);
    prev = d.dsr;
  }
  // return contract
  const d = E.deflatedSharpe(sr, T, skew, kurt, 1000, varTrials);
  assert.deepEqual(Object.keys(d).sort(), ['T', 'dsr', 'nTrials', 'sr', 'sr0']);
  assert.equal(d.sr, sr); assert.equal(d.T, T); assert.equal(d.nTrials, 1000);
  // undefined configurations return NaN fields, never a fake number
  for (const bad of [
    E.deflatedSharpe(NaN, T, skew, kurt, 1000, varTrials),
    E.deflatedSharpe(sr, 1, skew, kurt, 1000, varTrials),
    E.deflatedSharpe(sr, T, skew, kurt, 1000, -1),
    E.deflatedSharpe(sr, T, skew, kurt, NaN, varTrials),
  ]) assert.ok(Number.isNaN(bad.dsr), 'undefined DSR is NaN');
});

test('normCdf: matches the true Phi (catches a missing 1/sqrt(2) in the erf argument)', () => {
  // Phi(z) = 0.5*(1 + erf(z/sqrt(2))). Feeding |z| straight into the A&S erf
  // series computes Phi(z*sqrt(2)) — e.g. Phi(1)=0.9214 instead of 0.8413 and
  // Phi(-1.5)=0.0169 instead of 0.0668 — which inflates every PSR/DSR tail.
  const cases = [
    [0, 0.5], [1, 0.8413447461], [1.959963984540054, 0.975], [-1.5, 0.0668072013],
    [2.5, 0.9937903347], [3.5, 0.9997673709], [-3.0, 0.001349898],
  ];
  for (const [z, want] of cases) {
    assert.ok(Math.abs(E.normCdf(z) - want) < 1e-6, `Phi(${z}) = ${E.normCdf(z)} vs ${want}`);
  }
  // symmetry
  assert.ok(Math.abs(E.normCdf(-1.25) - (1 - E.normCdf(1.25))) < 1e-9);
});

test('PSR/DSR cross-check vs the Python engine (agreement to 1e-6)', () => {
  // Reference values produced by xbost_option_discovery (Python), the source of
  // truth. The JS must agree on BOTH columns; sr0 is Acklam-exact, the DSR
  // probability rides on the A&S CDF (|err| < 7.5e-8).
  const sr = 0.17083296083442204, T = 300;
  const skew = 0.29036094464332685, kurt = 3.2049111805880224;
  const varTrials = 0.0025;
  const ref = [
    { n: 1, sr0: 0.0000000000, dsr: 0.9986710534 },
    { n: 42, sr0: 0.1104346751, dsr: 0.8559589819 },
    { n: 1000, sr0: 0.1627560757, dsr: 0.5564850385 },
    { n: 335232, sr0: 0.2323542392, dsr: 0.1396061133 },
  ];
  let maxSr0 = 0, maxDsr = 0;
  for (const r of ref) {
    const d = E.deflatedSharpe(sr, T, skew, kurt, r.n, varTrials);
    maxSr0 = Math.max(maxSr0, Math.abs(d.sr0 - r.sr0));
    maxDsr = Math.max(maxDsr, Math.abs(d.dsr - r.dsr));
    assert.ok(Math.abs(d.sr0 - r.sr0) < 1e-9, `sr0 N=${r.n}: ${d.sr0} vs ${r.sr0}`);
    assert.ok(Math.abs(d.dsr - r.dsr) < 1e-6, `dsr N=${r.n}: ${d.dsr} vs ${r.dsr}`);
  }
  assert.ok(maxDsr < 1e-6, `max |dsr - python| = ${maxDsr.toExponential(3)}`);
  assert.ok(maxSr0 < 1e-9, `max |sr0 - python| = ${maxSr0.toExponential(3)}`);
});

test('perObservationSharpe: de-annualises the engine Sharpe (÷ sqrt(252))', () => {
  assert.equal(E.perObservationSharpe({ sharpe: Math.sqrt(252) }), 1);
  assert.equal(E.perObservationSharpe({ sharpe: 0 }), 0);
  assert.ok(Number.isNaN(E.perObservationSharpe(null)));
  assert.ok(Number.isNaN(E.perObservationSharpe({ sharpe: NaN })));
});

test('effectiveN: identical signals collapse to 1, exact duplicates removed', () => {
  const B = 4000;
  const sig = Int8Array.from({ length: B }, (_, i) => (((i >> 4) % 3) - 1));
  const same = [];
  for (let i = 0; i < 50; i++) same.push(Int8Array.from(sig));
  const out = E.effectiveN(same);
  assert.equal(out.effectiveN, 1, '50 identical series → 1 hypothesis');
  assert.equal(out.clusters, 1);
  assert.equal(out.exactDuplicates, 49, '49 exact duplicates detected');
  assert.equal(out.unique, 1);
  assert.equal(out.corrThreshold, 0.99, 'default |corr| threshold');
  assert.equal(typeof out.method, 'string');
});

test('effectiveN: perfectly anti-correlated series collapse (|corr| = 1)', () => {
  const B = 4000;
  const a = Int8Array.from({ length: B }, (_, i) => (((i >> 3) % 2) ? 1 : -1));
  const b = Int8Array.from(a, x => -x);
  const out = E.effectiveN([a, b]);
  assert.equal(out.exactDuplicates, 0, 'not exact duplicates');
  assert.equal(out.unique, 2);
  assert.equal(out.clusters, 1, 'anti-correlated → same cluster');
  assert.equal(out.effectiveN, 1);
});

test('effectiveN: independent random signals stay near the input count', () => {
  const B = 4000, N = 60;
  const r = rng(20240924);
  const signals = [];
  for (let i = 0; i < N; i++) {
    const s = new Int8Array(B);
    for (let j = 0; j < B; j++) { const u = r(); s[j] = u < 0.33 ? -1 : u < 0.66 ? 0 : 1; }
    signals.push(s);
  }
  const out = E.effectiveN(signals, { barSubsample: 2000 });
  assert.equal(out.unique, N, 'random series are all distinct');
  assert.ok(out.effectiveN >= Math.floor(N * 0.9), `independent → ~N hypotheses (got ${out.effectiveN}/${N})`);
  assert.ok(out.effectiveN <= N, 'can never exceed the input count');
});

test('effectiveN: deterministic across calls + scales to a larger population', () => {
  const B = 2000;
  const signals = [];
  const r = rng(7);
  for (let i = 0; i < 40; i++) {
    const s = new Int8Array(B);
    for (let j = 0; j < B; j++) { const u = r(); s[j] = u < 0.4 ? -1 : u < 0.7 ? 0 : 1; }
    signals.push(s);
  }
  const a = E.effectiveN(signals);
  const b = E.effectiveN(signals);
  assert.deepEqual(a, b, 'pure + deterministic');
  // identical input repeated twice is deduped (hash over the sampled bars)
  const doubled = signals.concat(signals.map(s => Int8Array.from(s)));
  const d = E.effectiveN(doubled);
  assert.equal(d.unique, a.unique, 'duplicated set has the same unique count');
  assert.equal(d.effectiveN, a.effectiveN, 'duplication never inflates effectiveN');
  assert.equal(d.exactDuplicates, 40);
  // nTotal extrapolates the sample estimate to a bigger searched population
  const scaled = E.effectiveN(signals, { nTotal: 40000 });
  assert.ok(scaled.effectiveN >= a.effectiveN, 'extrapolation is monotone in population');
  assert.ok(Math.abs(scaled.effectiveN - Math.round(40000 * a.clusters / a.sampled)) <= 1, 'documented scaling rule');
  // degenerate inputs never throw
  assert.equal(E.effectiveN([]).effectiveN, 0);
  assert.equal(E.effectiveN([[1], [1]]).effectiveN, 0, 'series shorter than 2 bars → 0 (documented)');
});

test('purgedFolds: train/test disjoint, purge + embargo respected', () => {
  const n = 2000, nSplits = 4, purge = 20, embargo = 10;
  const foldSize = Math.floor(n / (nSplits + 1)); // 400
  const folds = E.purgedFolds(n, nSplits, purge, embargo);
  assert.equal(folds.length, nSplits, 'all folds produced');
  for (const f of folds) {
    assert.ok(f.train[1] <= f.test[0], 'train ends at or before test starts');
    assert.ok(f.test[0] - f.train[1] >= purge, `purge gap of ≥ ${purge} bars`);
    assert.ok(f.test[1] - f.test[0] > 0, 'non-empty test window');
    assert.ok(f.test[1] - f.test[0] <= foldSize - embargo, `embargo of ${embargo} bars off the test tail`);
    assert.ok(f.test[1] <= n, 'test stays in range');
    assert.ok(f.train[0] === 0, 'anchored (expanding) train start');
  }
  // train windows nest; test windows advance and never overlap a later train
  for (let i = 1; i < folds.length; i++) {
    assert.ok(folds[i].train[1] > folds[i - 1].train[1], 'expanding train');
    assert.ok(folds[i].test[0] >= folds[i - 1].test[1], 'test windows never overlap');
  }
  // purge helps: a bigger purge pushes every test window later
  const strong = E.purgedFolds(n, nSplits, 100, embargo);
  assert.equal(strong.length, nSplits);
  strong.forEach((f, i) => assert.ok(f.test[0] - f.train[1] >= 100 && f.test[0] >= folds[i].test[0], 'larger purge honoured'));
});

test('purgedFolds: too-short series yields fewer/no folds, never a bad split', () => {
  // foldSize 5 → every trainEnd ≤ 25, all below the 50-bar warmup floor → no folds
  assert.deepEqual(E.purgedFolds(30, 5, 0, 0), [], 'far too short → zero folds');
  // foldSize 13: only the folds whose trainEnd > 50 survive → fewer than requested
  const some = E.purgedFolds(80, 5, 0, 0);
  assert.ok(some.length > 0 && some.length < 5, `fewer folds, got ${some.length}`);
  for (const f of some) {
    assert.ok(f.train[1] > 50, 'warmup floor respected');
    assert.ok(f.test[0] < f.test[1] && f.test[1] <= 80, 'no out-of-range split');
  }
  // an over-long purge/embargo can never produce an inverted window
  for (const f of E.purgedFolds(2000, 4, 0, 500)) assert.ok(f.test[0] < f.test[1], 'embargo never inverts a window');
  // and sane inputs are clamped, not thrown at
  assert.ok(Array.isArray(E.purgedFolds(0, 5, 0, 0)));
  assert.ok(Array.isArray(E.purgedFolds(100, 0, -5, -5)));
});
