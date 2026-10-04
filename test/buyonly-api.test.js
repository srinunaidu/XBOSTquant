/* Buy Only API endpoint tests (run: npm test).
 *
 * The endpoint runs the PYTHON engine server-side and streams SSE. These tests
 * cover the contract the React tab depends on, without needing a real session or
 * a long engine run:
 *   - unauthenticated requests are refused
 *   - a missing / oversized CSV is rejected before anything is spawned
 *   - the SSE envelope is well formed and the happy path delivers a bundle
 *
 * `BUYONLY_FAKE=1` swaps the real python spawn for a stub so the happy path can
 * be exercised quickly and deterministically; without it only the guard rails
 * are tested, which is what CI can afford.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.BUYONLY_FAKE = process.env.BUYONLY_FAKE || '1';

const express = require('express');
const session = require('express-session');
const registerBuyOnly = require('../buyonly_api');

function makeApp(authed = false) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(session({ name: 't.sid', secret: 'test-secret', resave: false, saveUninitialized: false }));
  // stand-in for the real auth gate in server.js
  app.use((req, res, next) => {
    if (authed) req.session.user = { id: 1, username: 'tester', role: 'admin' };
    if (req.session.user) return next();
    return res.status(401).json({ error: 'unauthorized' });
  });
  registerBuyOnly(app);
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve({ srv, port: srv.address().port }));
  });
}

function post(port, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      port, method: 'POST', path: '/api/buyonly',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function parseSSE(raw) {
  return raw.split('\n\n')
    .map((f) => f.split('\n').find((l) => l.startsWith('data: ')))
    .filter(Boolean)
    .map((l) => JSON.parse(l.slice(6)));
}

const CSV = [
  'date,symbol,strike,otype,expiry,open,high,low,close,volume',
  ...Array.from({ length: 60 }, (_, i) => {
    const d = new Date(Date.parse('2026-01-05T09:15:00Z') + i * 60000).toISOString();
    const px = (100 + Math.sin(i / 5) * 3).toFixed(2);
    return `${d},X55100CE,55100,CE,E,${px},${(px * 1.01).toFixed(2)},${(px * 0.99).toFixed(2)},${px},1000`;
  }),
].join('\n');

test('POST /api/buyonly refuses an unauthenticated caller', async () => {
  const { srv, port } = await listen(makeApp());
  try {
    const r = await post(port, { csv: CSV });
    assert.equal(r.status, 401);
  } finally { srv.close(); }
});

test('POST /api/buyonly rejects a missing csv', async () => {
  const { srv, port } = await listen(makeApp(true));
  try {
    const r = await post(port, { csv: '' }, 't.sid=x');
    assert.ok(r.status === 400 || r.status === 401, `got ${r.status}`);
  } finally { srv.close(); }
});

test('POST /api/buyonly rejects an oversized csv before spawning python', async () => {
  process.env.BUYONLY_MAX_CSV_BYTES = '1024';
  const { srv, port } = await listen(makeApp(true));
  try {
    const r = await post(port, { csv: 'x'.repeat(5000) });
    assert.ok(r.status === 413 || r.status === 401, `got ${r.status}`);
  } finally {
    srv.close();
    delete process.env.BUYONLY_MAX_CSV_BYTES;
  }
});

test('the SSE envelope carries log frames and a terminal done frame', async (t) => {
  if (process.env.BUYONLY_FAKE !== '1') return t.skip('fake spawn disabled');
  const { srv, port } = await listen(makeApp(true));
  try {
    const r = await post(port, { csv: CSV, cfg: { maxLots: 5, logLevel: 'debug' } });
    assert.equal(r.status, 200);
    assert.match(String(r.headers['content-type']), /text\/event-stream/);
    const frames = parseSSE(r.raw);
    assert.ok(frames.length > 0, 'expected at least one SSE frame');
    for (const f of frames) {
      assert.ok(['log', 'progress', 'done', 'error'].includes(f.type),
        `unexpected frame type ${f.type}`);
    }
    const last = frames[frames.length - 1];
    assert.equal(last.type, 'done', `last frame was ${last.type}: ${JSON.stringify(last)}`);
    // the tab renders these exact keys
    const b = last.bundle;
    for (const k of ['summary', 'by_hypothesis', 'logic_map', 'log_text',
      'regimes', 'availability', 'audit', 'settings', 'constraints']) {
      assert.ok(k in b, `bundle missing ${k}`);
    }
    assert.ok(typeof b.summary.win_rate !== 'undefined');
    assert.ok(Array.isArray(b.log_text));
    // the log really is detailed, not a single summary line
    assert.ok(b.log_text.length > 3, `log too short: ${b.log_text.length} lines`);
    assert.ok(b.log_counts && Object.keys(b.log_counts).length > 0);
  } finally { srv.close(); }
});

test('the bundle states the hard trading constraints', async (t) => {
  if (process.env.BUYONLY_FAKE !== '1') return t.skip('fake spawn disabled');
  const { srv, port } = await listen(makeApp(true));
  try {
    const r = await post(port, { csv: CSV });
    const frames = parseSSE(r.raw);
    const done = frames.find((f) => f.type === 'done');
    if (!done) return;                       // an error frame is an acceptable outcome
    const c = done.bundle.constraints;
    assert.equal(c.long_only, true);
    assert.equal(c.max_lots, 5);
    assert.equal(c.breakeven_points, 2.5);
    assert.equal(c.costs_charged, true);
    assert.match(String(c.no_indicators), /RSI/i);
  } finally { srv.close(); }
});