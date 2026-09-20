// Debug probe: samples run progress to find the stall point.
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
  page.on('pageerror', e => console.log('[pageerror] ' + String(e?.message || e).slice(0, 400)));
  page.on('console', m => { if (m.type() === 'error') console.log('[console.error] ' + m.text().slice(0, 300)); });
  const BASE = process.env.BASE || 'http://localhost:8931';
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
  // worker availability probe
  const wstat = await page.evaluate(async () => {
    try { const w = new Worker('/worker.js'); w.terminate(); return 'worker-ok'; }
    catch (e) { return 'worker-throw: ' + String(e && e.message || e).slice(0, 120); }
  });
  console.log('WORKER: ' + wstat);
  for (const tf of ['1m', '2m', '3m', '4m', '5m', '7m', '10m']) {
    await page.locator('.tf-pill', { hasText: tf }).click().catch(() => {});
  }
  const pills = await page.evaluate(() => [...document.querySelectorAll('.tf-pill')].map(b => b.textContent + ':' + (b.className.includes(' on') ? 'ON' : 'off')).join(' '));
  console.log('PILLS: ' + pills);
  await page.locator('button', { hasText: 'RUN GRID SEARCH' }).click();
  for (let s = 0; s < 55; s++) {
    await page.waitForTimeout(10000);
    const prog = await page.evaluate(() => {
      const b = document.body.innerText;
      const m = b.match(/.{0,90}(combos|refine|ERROR|stopped|warming up)[\s\S]{0,90}/);
      const rows = document.querySelectorAll('.ag-center-cols-container .ag-row').length;
      return (m ? m[0].replace(/\s+/g, ' ').slice(0, 160) : '(no progress text)') + ' | rows=' + rows;
    }).catch(e => 'EVAL-FAIL ' + e.message.slice(0, 100));
    console.log(`t+${(s + 1) * 10}s ${prog}`);
    if (/done ·|ERROR/.test(prog)) break;
  }
  await browser.close();
})().catch(e => { console.error('FATAL', (e?.message || e).slice(0, 200)); process.exit(1); });
