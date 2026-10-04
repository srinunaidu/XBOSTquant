/* Buy Only tab API — runs the PYTHON engine server-side and streams its log.
 *
 * The engine lives in xbost_option_discovery/buyonly (Python). A browser cannot
 * run it, and porting a statistically careful engine to JS is exactly how two
 * code paths start silently disagreeing. So this endpoint executes the real CLI,
 * streams its stdout to the browser as Server-Sent Events while the run is still
 * going, and returns the UI bundle the run produced.
 *
 * Protocol (POST, text/event-stream):
 *   data: {"type":"log","line":"..."}      repeated, live
 *   data: {"type":"progress","stage":"..."}
 *   data: {"type":"done","bundle":{...}}
 *   data: {"type":"error","message":"..."}
 *
 * The client POSTs and reads the response body as a stream (EventSource cannot
 * POST), which is why this is SSE over fetch rather than a plain EventSource.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PY = process.env.PYTHON_BIN || 'python3';
const { fakeRun } = require('./buyonly_fake');
// Read limits per request rather than at module load, so they stay adjustable at
// runtime (and so the size guard is actually testable).
const maxCsvBytes = () => Number(process.env.BUYONLY_MAX_CSV_BYTES || 120 * 1024 * 1024);
const timeoutMs = () => Number(process.env.BUYONLY_TIMEOUT_MS || 20 * 60 * 1000);
const maxConcurrent = () => Number(process.env.BUYONLY_MAX_CONCURRENT || 2);

let running = 0;

function pickPython() {
  // Prefer a python that actually has pandas; the repo targets 3.x.
  for (const cand of [process.env.PYTHON_BIN, 'python3', 'python3.12', 'python3.11', 'python'].filter(Boolean)) {
    try {
      const r = require('child_process').spawnSync(cand, ['-c', 'import pandas'], {
        stdio: 'ignore', timeout: 8000,
      });
      if (r.status === 0) return cand;
    } catch { /* try the next candidate */ }
  }
  return PY;
}

module.exports = function registerBuyOnly(app) {
  app.post('/api/buyonly', (req, res) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'unauthorized' });
    if (running >= maxConcurrent()) {
      return res.status(429).json({ error: `too many runs in flight (max ${maxConcurrent()})` });
    }
    const b = req.body || {};
    const csv = String(b.csv || '');
    if (!csv || csv.length < 10) return res.status(400).json({ error: 'csv required' });
    if (csv.length > maxCsvBytes()) {
      return res.status(413).json({ error: `csv too large (max ${Math.round(maxCsvBytes() / 1048576)} MB)` });
    }

    const cfg = b.cfg && typeof b.cfg === 'object' ? b.cfg : {};
    const num = (v, d) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? d : Number(v));
    const flags = [
      '--max-lots', String(Math.min(50, Math.max(1, num(cfg.maxLots, 5)))),
      '--lot-size', String(Math.min(1000, Math.max(1, num(cfg.lotSize, 15)))),
      '--max-itm-steps', String(Math.min(10, Math.max(0, num(cfg.maxItmSteps, 2)))),
      '--target-itm-steps', String(Math.min(10, Math.max(0, num(cfg.targetItmSteps, 1)))),
      '--min-stop-points', String(Math.min(500, Math.max(1, num(cfg.minStopPoints, 30)))),
      '--breakeven-points', String(Math.min(100, Math.max(0, num(cfg.breakevenPoints, 2.5)))),
      '--brokerage-per-order', String(Math.min(1000, Math.max(0, num(cfg.brokeragePerOrder, 20)))),
      '--target-r', String(Math.min(20, Math.max(0.1, num(cfg.targetR, 2)))),
      '--max-hold-bars', String(Math.min(500, Math.max(1, num(cfg.maxHoldBars, 45)))),
      '--max-consecutive-losses', String(Math.min(20, Math.max(1, num(cfg.maxConsecutiveLosses, 2)))),
      '--log-level', ['quiet', 'info', 'debug', 'trace'].includes(cfg.logLevel) ? cfg.logLevel : 'info',
      '--timing-perms', String(Math.min(200, Math.max(0, num(cfg.timingPerms, 20)))),
    ];
    if (cfg.sensitivity) flags.push('--sensitivity');
    if (cfg.noRegimeRestrict) flags.push('--no-regime-restrict');
    if (cfg.hypothesis) flags.push('--single-hypothesis', String(cfg.hypothesis).slice(0, 40));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbost-buyonly-'));
    const csvPath = path.join(dir, 'chain.csv');
    const bundlePath = path.join(dir, 'bundle.json');
    const outdir = path.join(dir, 'out');
    fs.writeFileSync(csvPath, csv);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders && res.flushHeaders();

    const send = (obj) => {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ }
    };

    send({ type: 'log', line: `[server] python=${pickPython()} outdir=${outdir}` });
    send({ type: 'log', line: `[server] flags=${flags.join(' ')}` });

    const py = pickPython();
    const child = process.env.BUYONLY_FAKE === '1'
      // Test seam: emit a deterministic stream + minimal bundle so the SSE
      // contract can be exercised without a Python process. Never active in a
      // normal run; the flag must be set explicitly.
      ? fakeRun(csv, flags, bundlePath)
      : spawn(py, [
      '-u', '-m', 'xbost_option_discovery.run_buyonly',
      '--path', csvPath, '--outdir', outdir, '--emit-bundle', bundlePath,
      ...flags,
    ], {
      cwd: __dirname,
      env: { ...process.env, PYTHONPATH: path.join(__dirname) + path.delimiter + (process.env.PYTHONPATH || '') },
    });

    running += 1;
    let settled = false;
    let buf = '';
    const cleanup = () => {
      running = Math.max(0, running - 1);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    };
    const finish = (fn) => { if (settled) return; settled = true; fn(); cleanup(); };

    const timer = setTimeout(() => {
      send({ type: 'log', line: `[server] TIMEOUT after ${timeoutMs()}ms — killing` });
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs());

    child.stdout.on('data', (d) => {
      buf += d.toString();
      const parts = buf.split('\n');
      buf = parts.pop() || '';
      for (const line of parts) {
        if (!line.trim()) continue;
        send({ type: 'log', line });
        const m = /^\[\s*[\d.]+s\]\s+(\w+)\s+(.*)$/.exec(line);
        if (m) send({ type: 'progress', kind: m[1], stage: m[2].slice(0, 120) });
      }
    });
    child.stderr.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        if (line.trim()) send({ type: 'log', line: `[stderr] ${line}` });
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      send({ type: 'error', message: `spawn failed: ${e.message}` });
      finish(() => res.end());
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        send({ type: 'error', message: `engine exited with code ${code}` });
        return finish(() => res.end());
      }
      let bundle = null;
      try {
        bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
      } catch (e) {
        send({ type: 'error', message: `bundle unreadable: ${e.message}` });
        return finish(() => res.end());
      }
      // Ship the log inside the bundle too, so a reloaded page can still show it.
      send({ type: 'done', bundle });
      finish(() => res.end());
    });
  });
};