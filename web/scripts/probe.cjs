// Headless boot probe: loads the built app, captures console + page errors,
// asserts login form renders, logs in, asserts terminal shell renders.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
  page.on('pageerror', e => logs.push(`[pageerror] ${String(e && e.message || e).slice(0, 500)}`));
  page.on('requestfailed', r => logs.push(`[reqfail] ${r.url().slice(0, 120)} :: ${r.failure()?.errorText}`));

  const BASE = process.env.BASE || 'http://localhost:8930';
  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 }).catch(e => logs.push('[goto] ' + e.message));
  await page.waitForTimeout(2500);
  console.log('BODY-LEN:', await page.evaluate(() => document.body.innerHTML.length));
  console.log('BODY-TXT:', (await page.evaluate(() => document.body.innerText || '')).slice(0, 200));
  console.log('EARLY-LOGS:'); console.log(logs.join('\n') || '(none)');

  const hasLogin = await page.locator('text=Restricted · login required').count();
  const hasUser = await page.locator('input').count();
  console.log('LOGIN-FORM visible:', hasLogin > 0, '| inputs:', hasUser);

  // login as admin
  const inputs = page.locator('input');
  await inputs.nth(0).fill(process.env.ADMIN_USER || 'admin');
  await inputs.nth(1).fill(process.env.ADMIN_PASS || 'testpass123');
  await page.locator('button[type=submit]').click();
  await page.waitForTimeout(2500);
  console.log('AFTER-SUBMIT body:', (await page.evaluate(() => document.body.innerText || '')).slice(0, 300).replace(/\s+/g, ' '));
  console.log('POST-SUBMIT logs:'); console.log(logs.slice(-10).join('\n') || '(none)');

  const terminal = await page.locator('text=QUANT TERMINAL').count();
  const kpis = await page.locator('text=Win Rate').count();
  const pills = await page.locator('.tf-pill').count();
  const indCards = await page.locator('.ind-card').count();
  console.log('TERMINAL header:', terminal > 0, '| KPI WinRate:', kpis > 0, '| tf pills:', pills, '| ind cards:', indCards);

  // upload a small CSV through the file input and check the badge
  const csv = 'date,open,high,low,close,volume\n' + Array.from({ length: 500 }, (_, i) => {
    const c = 100 + Math.sin(i / 9) * 4 + i * 0.02;
    const d = new Date(Date.parse('2024-01-02T09:15:00') + i * 60000);
    const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') +
      ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':00';
    return `${iso},${c.toFixed(2)},${(c + 0.3).toFixed(2)},${(c - 0.3).toFixed(2)},${c.toFixed(2)},5000`;
  }).join('\n');
  await page.locator('input[type=file]').setInputFiles([{ name: 'PROBE_F1.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) }]);
  await page.waitForTimeout(1500);
  const badge = await page.locator('.badge-live, #root').first().textContent().catch(() => '');
  console.log('BADGE-AREA:', (badge || '').slice(0, 120).replace(/\s+/g, ' '));

  console.log('--- console/page errors ---');
  const errs = logs.filter(l => /error|fail|Error|Reqfail|reqfail/i.test(l) && !/favicon/i.test(l));
  console.log(errs.length ? errs.slice(0, 25).join('\n') : '(none relevant)');
  console.log('--- all logs tail ---');
  console.log(logs.slice(-8).join('\n'));
  await browser.close();
})().catch(e => { console.error('PROBE FATAL', e); process.exit(1); });
