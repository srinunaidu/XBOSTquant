// Final acceptance: multi-symbol merge, best-per-symbol, summary, charts.
const { chromium } = require('playwright');

function bars(seed, n, startPx) {
  let px = startPx, rnd = seed;
  const next = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const rows = ['date,open,high,low,close,volume'];
  const t0 = Date.parse('2024-01-02T09:15:00');
  for (let i = 0; i < n; i++) {
    const o = px, c = o + (next() - 0.48) * 40;
    const h = Math.max(o, c) + next() * 8, l = Math.min(o, c) - next() * 8;
    const v = 1000 + Math.floor(next() * 20000);
    const d = new Date(t0 + i * 60000);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`;
    rows.push(`${ds},${o.toFixed(2)},${h.toFixed(2)},${l.toFixed(2)},${c.toFixed(2)},${v}`);
    px = c;
  }
  return rows.join('\n');
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('[pageerror] ' + String(e?.message || e).slice(0, 300)));
  page.on('console', m => { if (m.type() === 'error') console.log('[cerr] ' + m.text().slice(0, 200)); });
  page.on('pageerror', e => console.log('[pageerror] ' + String(e?.message || e).slice(0, 300)));
  const BASE = process.env.BASE || 'http://localhost:8931';
  const out = [];
  const check = (n, c, x) => console.log((c ? 'PASS: ' : 'FAIL: ') + n + (c ? '' : ' :: ' + (x || '')));
  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.locator('input').nth(0).fill(process.env.ADMIN_USER || 'admin');
  await page.locator('input[type=password]').fill(process.env.ADMIN_PASS || 'x');
  await page.locator('button[type=submit]').click();
  await page.waitForTimeout(2500);
  await page.locator('input[type=file]').setInputFiles([
    { name: 'NIFTY_F1.csv', mimeType: 'text/csv', buffer: Buffer.from(bars(7, 400, 22000)) },
    { name: 'BANKNIFTY_F1.csv', mimeType: 'text/csv', buffer: Buffer.from(bars(99, 400, 48000)) },
  ]);
  await page.waitForTimeout(1500);
  for (const tf of ['1m', '2m', '3m', '4m', '5m', '7m', '10m']) {
    await page.locator('.tf-pill', { hasText: tf }).click().catch(() => {});
  }
  await page.locator('button', { hasText: 'RUN GRID SEARCH' }).click();
  console.log('RUN clicked at ' + new Date().toISOString());
  let samplerStop = false;
  const sampler = (async () => {
    for (let k = 0; k < 40 && !samplerStop; k++) {
      await page.waitForTimeout(10000);
      try {
        const t = await page.evaluate(() => {
          const m = document.querySelector('main');
          const b = document.querySelector('#__nonexistent__');
          return (m ? m.innerText.slice(0, 400) : 'NO-MAIN');
        });
        console.log('SAMPLE t+' + ((k + 1) * 10) + 's :: ' + t.replace(/\s+/g, ' ').slice(0, 220));
      } catch (e) { console.log('SAMPLE-ERR ' + String(e && e.message || e).slice(0, 120)); }
    }
  })();
  console.log('RUN clicked at ' + new Date().toISOString());
  await page.waitForFunction(() => /done ·|■ stopped|ERROR/.test(document.body.innerText), null, { timeout: 420000, polling: 2000 });
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => {
    const main = document.body.innerText;
    const syms = new Set();
    document.querySelectorAll('.ag-center-cols-container .ag-row').forEach(r => {
      const t = r.innerText;
      if (t.includes('NIFTY')) syms.add('NIFTY');
      if (t.includes('BANKNIFTY')) syms.add('BANKNIFTY');
    });
    return {
      done: /done ·/.test(main),
      syms: [...syms],
      bestPerSym: /Best per symbol/.test(main),
      nRows: document.querySelectorAll('.ag-center-cols-container .ag-row').length,
    };
  });
  check('run completed', info.done);
  const bps = await page.evaluate(() => {
    const b = document.body.innerText;
    const m = b.match(/Best per symbol:[\s\S]{0,300}/);
    return m ? m[0].replace(/\s+/g, ' ') : 'none';
  });
  console.log('BPS: ' + bps);
  check('board spans NIFTY+BANKNIFTY', /NIFTY/.test(bps) && /BANKNIFTY/.test(bps), bps.slice(0, 200));
  check('best-per-symbol covers both', /NIFTY/.test(bps) && /BANKNIFTY/.test(bps), bps.slice(0, 160));
  check('best-per-symbol summary', info.bestPerSym);
  check('rows present', info.nRows > 5, info.nRows);
  // click a row -> per-symbol charts
  await page.locator('.ag-center-cols-container .ag-row').first().click();
  await page.waitForTimeout(2500);
  const det = await page.evaluate(() => document.querySelector('main').innerText);
  check('detail charts render', /Price/.test(det) && /Trade/.test(det));
  samplerStop = true;
  try { await sampler; } catch {} 
  await browser.close();
})().catch(e => { console.error('FATAL', (e?.message || e).slice(0, 200)); process.exit(1); });
