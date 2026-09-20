// Multi-symbol browser E2E: 2 CSVs -> run -> merged board -> summary -> charts.
const { chromium } = require('playwright');

function bars(sym, seed, n, startPx) {
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
  const logs = [];
  page.on('pageerror', e => logs.push('[pageerror] ' + String(e?.message || e).slice(0, 300)));
  const BASE = process.env.BASE || 'http://localhost:8931';
  const fail = (m) => { console.log('FAIL: ' + m); };
  const pass = (m) => { console.log('PASS: ' + m); };
  try {
    await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.locator('input').nth(0).fill(process.env.ADMIN_USER || 'admin');
    await page.locator('input[type=password]').fill(process.env.ADMIN_PASS || 'x');
    await page.locator('button[type=submit]').click();
    await page.waitForTimeout(2500);
    if (!await page.locator('text=QUANT TERMINAL').count()) throw new Error('no terminal after login');

    await page.locator('input[type=file]').setInputFiles([
      { name: 'NIFTY_F1.csv', mimeType: 'text/csv', buffer: Buffer.from(bars('N', 7, 300, 22000)) },
      { name: 'BANKNIFTY_F1.csv', mimeType: 'text/csv', buffer: Buffer.from(bars('B', 99, 300, 48000)) },
    ]);
    await page.waitForTimeout(2000);
    const dsTxt = await page.evaluate(() => document.body.innerText);
    (dsTxt.includes('NIFTY') && dsTxt.includes('BANKNIFTY')) ? pass('both datasets listed') : fail('datasets missing');

    await page.locator('button', { hasText: 'RUN GRID SEARCH' }).click();
    await page.waitForFunction(() => {
      const el = document.querySelector('main');
      const txt = el ? el.innerText : '';
      return /done ·/.test(txt) || /■ stopped/.test(txt) || /ERROR/.test(txt);
    }, null, { timeout: 420000, polling: 2000 });
    await page.waitForTimeout(1000);
    const main = await page.evaluate(() => document.querySelector('main').innerText);
    /done ·/.test(main) ? pass('run completed') : fail('run did not complete: ' + main.slice(0, 200));
    const hasN = main.includes('NIFTY'), hasB = main.includes('BANKNIFTY');
    (hasN && hasB) ? pass('board spans both symbols') : fail('board missing a symbol');
    /Best per symbol/.test(main) ? pass('best-per-symbol shown') : fail('no best-per-symbol');

    // click first leaderboard row -> charts + trades
    const rows = page.locator('.ag-center-cols-container .ag-row');
    const n = await rows.count();
    pass('board rows: ' + n);
    if (n > 0) {
      await rows.first().click();
      await page.waitForTimeout(2000);
      const t2 = await page.evaluate(() => document.querySelector('main').innerText);
      (/Price/.test(t2) && /Trade/.test(t2)) ? pass('charts+trades render') : fail('detail missing');
    }
    const errs = logs.filter(l => !/favicon|404/.test(l));
    console.log(errs.length ? 'PAGE ERRORS:\n' + errs.slice(0, 10).join('\n') : 'no page errors');
  } catch (e) {
    console.log('PROBE FATAL: ' + (e?.message || e).slice(0, 300));
  }
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
