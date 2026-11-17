/* XBOST server — session-auth gateway in front of the static terminal.
 * Public:  /login.html, /api/login
 * Guarded: everything else (terminal, engine, data) requires a login session.
 * Users live in a JSON file (users.json). Admin bootstrap via ADMIN_USER/ADMIN_PASS.
 */
'use strict';
const express = require('express');
const session = require('express-session');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const NodeCache = require('node-cache');
const { TOTP } = require('otpauth');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 10000;
// Serve the React build when present, else fall back to the classic terminal.
const DIST_DIR = path.join(__dirname, 'web', 'dist');
const PUBLIC_DIR = fs.existsSync(path.join(DIST_DIR, 'index.html')) ? DIST_DIR : path.join(__dirname, 'public');
const USERS_FILE = process.env.USERS_FILE || '/app/data/users.json';
if (process.env.USERS_FILE && !require('fs').existsSync(require('path').dirname(USERS_FILE))) console.warn(`[auth] USERS_FILE dir ${require('path').dirname(USERS_FILE)} does not exist — will attempt to create`);
if (!process.env.USERS_FILE) console.warn('[auth] USERS_FILE not set — using default /app/data/users.json (ensure /app/data is a persistent disk)');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || 'xbost-dev-secret-change-me';
const BUYONLY_MAX_PERMS = Number(process.env.BUYONLY_MAX_PERMS || 200);
// Ensure data dir exists for Render disk mount (best-effort, no throw in local dev/CI)
try { require('fs').mkdirSync('/app/data', {recursive:true}); } catch(e){ /* cannot create /app/data in local env, will fallback */ }
// fallback: if /app/data not writable, use repo-local users.json
try { require('fs').accessSync('/app/data', require('fs').constants.W_OK); } catch(e) { /* use USERS_FILE as is, saveUsers will mkdir parent */ }

if (!process.env.SESSION_SECRET) console.warn('[auth] SESSION_SECRET not set — using dev default. Set it in production.');
if (!process.env.ADMIN_PASS) console.warn('[auth] ADMIN_PASS not set — admin password is "changeme". Change it on first login.');

// ---- tiny JSON user store (no native deps, no build toolchain needed) ----
let users = [];
function loadUsers() {
  try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); if (!Array.isArray(users)) users = []; }
  catch (e) { try { const fb=require('path').join(__dirname,'users.json'); users = JSON.parse(require('fs').readFileSync(fb,'utf8')); if(!Array.isArray(users)) users=[]; } catch(e2){ users = []; } }
}
function saveUsers() {
  try { fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true }); } catch(e){ /* fallback to local users.json if /app/data not writable */ try { const fallback = require('path').join(__dirname, 'users.json'); const tmp2=fallback+'.tmp'; require('fs').writeFileSync(tmp2, JSON.stringify(users)); require('fs').renameSync(tmp2, fallback); return; } catch(e2){} throw e; }
  const tmp = USERS_FILE + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(users)); fs.renameSync(tmp, USERS_FILE); } catch(e){ // fallback
    try { const fallback = require('path').join(__dirname, 'users.json'); const tmp2=fallback+'.tmp'; require('fs').writeFileSync(tmp2, JSON.stringify(users)); require('fs').renameSync(tmp2, fallback); } catch(e2){ throw e; }
  }
}
loadUsers();

// bootstrap admin
if (!users.some(u => u.username === ADMIN_USER)) {
  users.push({ id: users.reduce((m, u) => Math.max(m, u.id), 0) + 1, username: ADMIN_USER,
    pass_hash: bcrypt.hashSync(ADMIN_PASS, 10), role: 'admin', active: true,
    created_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
  saveUsers();
  console.log(`[auth] bootstrap admin user "${ADMIN_USER}" created`);
}

const app = express();
// The Buy Only tab POSTs the whole options CSV so the Python engine can run it
// server-side, which is far larger than any other payload here. Raising the
// global limit is acceptable because the route that accepts big bodies is
// session-gated and separately caps the CSV size in buyonly_api.js.
const JSON_LIMIT = process.env.JSON_BODY_LIMIT || '150mb';
app.use(express.json({ limit: JSON_LIMIT }));
app.use(session({
  name: 'xbost.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 12 * 3600 * 1000 }
}));

// ---- light login throttle: 10 failures / 5 min per ip ----
const fails = new Map();
function throttled(ip) {
  const r = fails.get(ip);
  return r && r.until > Date.now() && r.count >= 10;
}
function noteFail(ip) {
  const r = fails.get(ip) || { count: 0, until: 0 };
  if (Date.now() > r.until) { r.count = 0; r.until = Date.now() + 5 * 60 * 1000; }
  r.count++;
  fails.set(ip, r);
}

// ---- auth APIs ----
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (throttled(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 5 minutes.' });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  const u = users.find(x => x.username === String(username).trim());
  if (!u || !u.active || !bcrypt.compareSync(String(password), u.pass_hash)) {
    noteFail(ip);
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
  req.session.user = { id: u.id, username: u.username, role: u.role };
  res.json({ ok: true, user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/health', (req,res)=>res.json({ok:true, uptime:process.uptime()}));
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'unauthorized' });
  res.json({ user: req.session.user });
});

// Client crash/error reports: the tab may die right after sending, so the
// browser beacons errors here and the SERVER log (Railway dashboard →
// Deployments → View Logs) keeps the evidence. Public endpoint (a dying tab
// may have no session), throttled per IP, payload truncated server-side.
const errHits = new Map();
app.post('/api/client-error', (req, res) => {
  try {
    const ip = req.ip;
    const now = Date.now();
    const h = errHits.get(ip) || { n: 0, until: 0 };
    if (now > h.until) { h.n = 0; h.until = now + 60000; }
    h.n++;
    errHits.set(ip, h);
    if (h.n > 20) return res.status(429).json({ error: 'throttled' });
    const b = req.body || {};
    const s = v => String(v == null ? '' : v).slice(0, 500);
    const stack = String(b.stack || '').split('\n').slice(0, 4).join(' | ').slice(0, 800);
    console.error(`[client-error] ip=${ip} user=${req.session && req.session.user ? req.session.user.username : '-'} msg=${s(b.message)} stack=${stack} url=${s(b.url)} run=${s(b.run)} heap=${s(b.heap)} board=${s(b.board)} tail=${s(b.tail)}`);
  } catch { /* never fail the reporter */ }
  res.json({ ok: true });
});

// ---- Buy Only tab: runs the Python buy-only engine and streams its log ----
require('./buyonly_api')(app);

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'unauthorized' });
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  next();
}

const pubUser = r => ({ id: r.id, username: r.username, role: r.role, active: !!r.active, created_at: r.created_at });
app.get('/api/users', requireAdmin, (req, res) => {
  res.json({ users: users.slice().sort((a, b) => a.id - b.id).map(pubUser) });
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(name)) return res.status(400).json({ error: 'Username: 3-32 chars, letters/digits/._-' });
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'Password: minimum 8 characters.' });
  if (users.some(u => u.username === name)) return res.status(409).json({ error: 'Username already exists.' });
  const nu = { id: users.reduce((m, u) => Math.max(m, u.id), 0) + 1, username: name,
    pass_hash: bcrypt.hashSync(String(password), 10), role: role === 'admin' ? 'admin' : 'user',
    active: true, created_at: new Date().toISOString().slice(0, 19).replace('T', ' ') };
  users.push(nu);
  saveUsers();
  res.status(201).json({ ok: true, user: pubUser(nu) });
});

app.patch('/api/users/:id', requireAdmin, (req, res) => {
  const id = +req.params.id;
  const target = users.find(u => u.id === id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  const me = req.session.user;
  const { active, password, role } = req.body || {};
  if (target.id === me.id && active === false) return res.status(400).json({ error: 'Cannot deactivate yourself.' });
  if (target.id === me.id && role && role !== 'admin') return res.status(400).json({ error: 'Cannot demote yourself.' });
  if (active !== undefined) target.active = !!active;
  if (password !== undefined) {
    if (String(password).length < 8) return res.status(400).json({ error: 'Password: minimum 8 characters.' });
    target.pass_hash = bcrypt.hashSync(String(password), 10);
  }
  if (role !== undefined) {
    if (target.id === me.id) return res.status(400).json({ error: 'Cannot change your own role.' });
    target.role = role === 'admin' ? 'admin' : 'user';
  }
  saveUsers();
  res.json({ ok: true, user: pubUser(target) });
});

// ---- gate: login page + APIs public, everything else needs a session ----
// Dist (React SPA) mode: NO redirects anywhere — fragment URLs loop through
// proxies that strip them. Unauthenticated navigations get the app shell
// (HTTP 200) and the client router renders Login; the JS bundle itself is
// public so the form can boot, while engine/worker/data stay guarded.

// ---- Angel One proxy: POST /api/angel/login + /api/angel/candles ----
// Throttling + caching + TOTP window=1 + redacted logging + mapping to Data{t,o,h,l,c,v} sorted
const angelCache = new NodeCache({ stdTTL: 300, checkperiod: 60, maxKeys: 100 });
let angelCacheCount = 0;

// Redact helper for logs
function redact(str) {
  if (!str) return str;
  const s = String(str);
  if (s.length <= 4) return '***';
  return s.slice(0,2) + '***' + s.slice(-2);
}
function redactLog(obj) {
  if (!obj || typeof obj !== 'object') return redact(String(obj));
  const out = { ...obj };
  for (const k of Object.keys(out)) {
    if (/apiKey|clientCode|password|totp|authorization|x-privatekey/i.test(k)) out[k] = '***';
  }
  return out;
}

function isAngelAuthenticated(req) {
  return !!(req.session && req.session.user);
}

// rate limiters
const angelLoginLimiter = rateLimit({
  windowMs: 60000,
  max: 5,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.setHeader('Retry-After', '60');
    res.status(429).json({ ok: false, error: 'rate_limited' });
  }
});

const angelCandlesLimiter = rateLimit({
  windowMs: 60000,
  max: 10,
  keyGenerator: (req) => (req.session && req.session.user ? String(req.session.user.id || req.session.user.username) : ipKeyGenerator(req.ip)),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.setHeader('Retry-After', '60');
    res.status(429).json({ error: 'rate_limited' });
  }
});

function validateAngelDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('invalid_date');
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d.getTime())) throw new Error('invalid_date');
  return d;
}

function todayISTStr() {
  const now = new Date();
  const istOffset = 5.5*60;
  const utc = now.getTime() + now.getTimezoneOffset()*60000;
  const ist = new Date(utc + istOffset*60000);
  return ist.toISOString().slice(0,10);
}
function parseISTTimestamp(tsStr) {
  // tsStr like "2026-11-14T09:15:00" IST → epoch ms
  let dt = null;
  for (const fmt of ['%Y-%m-%dT%H:%M:%S','%Y-%m-%d %H:%M:%S']) { /* not used */ }
  // Try ISO parse assuming IST if no tz
  try {
    // If contains T, treat as IST
    if (tsStr.includes('T')) {
      const [date, time] = tsStr.split('T');
      const [y,m,d] = date.split('-').map(Number);
      const [hh,mm,ss] = time.split(':').map(Number);
      // IST is UTC+5:30 → UTC = IST - 5:30
      const utcMs = Date.UTC(y, m-1, d, hh, mm, ss || 0) - (5.5*60*60*1000);
      return utcMs;
    } else {
      const [date, time] = tsStr.split(' ');
      const [y,m,d] = date.split('-').map(Number);
      const [hh,mm] = time.split(':').map(Number);
      const utcMs = Date.UTC(y, m-1, d, hh, mm, 0) - (5.5*60*60*1000);
      return utcMs;
    }
  } catch { return null; }
}

// POST /api/angel/login
app.post('/api/angel/login', angelLoginLimiter, async (req, res) => {
  if (!isAngelAuthenticated(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const body = req.body || {};
  const apiKey = String(body.apiKey || body.api_key || '').trim();
  const clientCode = String(body.clientCode || body.client_code || body.clientcode || '').trim();
  const password = String(body.password || '').trim();
  const totpSecret = String(body.totpSecret || body.totp_secret || body.totp || '').trim();
  if (!apiKey || !clientCode || !password || !totpSecret) {
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  }
  // Generate TOTP with window=1 (±30s)
  let totpCandidates = [];
  try {
    const totp = new TOTP({ secret: totpSecret, digits: 6, period: 30, algorithm: 'SHA1' });
    const now = Date.now();
    for (const delta of [-30000, 0, 30000]) {
      try {
        const c = totp.generate({ timestamp: now + delta });
        if (!totpCandidates.includes(c)) totpCandidates.push(c);
      } catch {}
    }
    if (!totpCandidates.length) totpCandidates = [totp.generate()];
  } catch (e) {
    console.warn('[angel] TOTP generation failed: ' + redact(String(e.message || e)));
    return res.status(401).json({ ok: false, error: 'auth_failed' });
  }
  console.log('[angel] login attempt clientCode=' + redact(clientCode) + ' apiKey=' + redact(apiKey.slice(0,4)) + '...');
  const url = 'https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword';
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': req.ip || '127.0.0.1',
    'X-ClientPublicIP': req.ip || '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00',
    'X-PrivateKey': apiKey,
  };
  let lastResp = null;
  for (const totp of totpCandidates) {
    const payload = { clientcode: clientCode, password, totp };
    try {
      const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
      let j = {};
      try { j = await resp.json(); } catch {
        try { const t = await resp.text(); j = JSON.parse(t); } catch {}
      }
      if (resp.status === 200 && j && j.status === true) {
        let jwt = '';
        const dataField = j.data || {};
        if (typeof dataField === 'object') jwt = dataField.jwtToken || dataField.jwt || dataField.accessToken || '';
        if (!jwt) {
          jwt = resp.headers.get('authorization') || '';
          if (jwt.toLowerCase().startsWith('bearer ')) jwt = jwt.slice(7);
        }
        req.session.angel_jwt = jwt;
        req.session.angelClientCode = clientCode;
        req.session.angelApiKey = apiKey;
        console.log('[angel] login success clientCode=' + redact(clientCode));
        return res.json({ ok: true, clientCode, jwt: jwt ? jwt.slice(0,20) + '...' : null });
      }
      lastResp = { status: resp.status, body: j };
      console.warn('[angel] login attempt failed clientCode=' + redact(clientCode) + ' totp=' + redact(totp.slice(0,2)) + '.. status=' + resp.status + ' msg=' + redact(j && j.message));
    } catch (e) {
      lastResp = { error: String(e) };
      console.warn('[angel] login upstream error: ' + redact(String(e.message || e)));
    }
  }
  console.warn('[angel] login failed clientCode=' + redact(clientCode) + ' after ' + totpCandidates.length + ' candidates');
  return res.status(401).json({ ok: false, error: 'auth_failed' });
});

// POST /api/angel/candles
app.post('/api/angel/candles', angelCandlesLimiter, async (req, res) => {
  if (!isAngelAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
  const body = req.body || {};
  const exchange = String(body.exchange || '').trim().toUpperCase();
  const interval = String(body.interval || '').trim();
  const fromDate = String(body.fromDate || body.fromdate || body.from_date || '').trim();
  const toDate = String(body.toDate || body.todate || body.to_date || '').trim();
  let rawSymbol = String(body.symbolToken || body.symbol_token || body.symboltoken || body.symbol || '').trim();
  if (!rawSymbol && body.symbol) rawSymbol = String(body.symbol).trim();

  if (!['NSE','BSE','MCX','NFO'].includes(exchange)) return res.status(400).json({ error: 'invalid_exchange' });
  if (interval !== 'ONE_MINUTE') return res.status(400).json({ error: 'invalid_interval' });
  if (!fromDate || !toDate) return res.status(400).json({ error: 'missing_dates' });
  let fromDt, toDt;
  try { fromDt = validateAngelDate(fromDate); toDt = validateAngelDate(toDate); } catch (e) { return res.status(400).json({ error: 'invalid_date' }); }
  if (toDt < fromDt) return res.status(400).json({ error: 'invalid_range' });
  const todayStr = todayISTStr();
  if (toDate > todayStr) return res.status(400).json({ error: 'invalid_range' });
  const diffDays = Math.round((toDt - fromDt)/86400000);
  if (diffDays > 30) return res.status(400).json({ error: 'invalid_range' });

  // Resolve token
  let token = null;
  try {
    const { resolveSymbol } = require('./server/utils/angel_tokens');
    token = resolveSymbol(rawSymbol, exchange);
  } catch (e) {
    return res.status(400).json({ error: 'unknown_symbol' });
  }
  if (!token) return res.status(400).json({ error: 'unknown_symbol' });

  const jwt = req.session.angel_jwt;
  const apiKey = req.session.angelApiKey;
  if (!jwt) return res.status(401).json({ error: 'not_authenticated', message: 'Please Test Connection first' });

  const cacheKey = exchange + ':' + token + ':' + interval + ':' + fromDate + ':' + toDate;
  const cached = angelCache.get(cacheKey);
  if (cached !== undefined) {
    res.setHeader('X-Cache', 'HIT');
    return res.json({ data: cached, cached: true });
  }

  const fromStr = fromDate + ' 09:15';
  const toStr = toDate + ' 15:30';
  const payload = { exchange, symboltoken: token, interval, fromdate: fromStr, todate: toStr };
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-PrivateKey': apiKey || '',
    'Authorization': 'Bearer ' + jwt,
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': req.ip || '127.0.0.1',
    'X-ClientPublicIP': req.ip || '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00',
  };
  console.log('[angel] candles fetch ' + redact(cacheKey) + ' ' + fromStr + '->' + toStr);
  try {
    const url = 'https://apiconnect.angelbroking.com/rest/secure/angelbroking/historical/v1/getCandleData';
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
    if (resp.status === 429) {
      return res.status(502).json({ error: 'upstream_rate_limit', retry_after: resp.headers.get('Retry-After') || '60' });
    }
    let j = null;
    try { j = await resp.json(); } catch { j = {}; }
    if (resp.status !== 200 || !j || !j.status) {
      const msg = (j && j.message) ? j.message : 'no_data_for_range';
      console.warn('[angel] candles upstream fail ' + resp.status + ' ' + redact(msg));
      return res.status(502).json({ error: 'upstream_error', message: 'no_data_for_range' });
    }
    const rawData = j.data || [];
    const mapped = [];
    for (const row of rawData) {
      try {
        if (!Array.isArray(row) || row.length < 6) continue;
        const tsStr = String(row[0]);
        const o = row[1], h = row[2], l = row[3], c = row[4], v = row[5];
        const t = parseISTTimestamp(tsStr);
        if (t == null || isNaN(t)) continue;
        mapped.push({ t, o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v) || 0 });
      } catch {}
    }
    mapped.sort((a,b) => a.t - b.t);
    angelCache.set(cacheKey, mapped);
    // enforce max 100 is handled by NodeCache maxKeys, but also manual evict if needed
    res.setHeader('X-Cache', 'MISS');
    return res.json({ data: mapped, cached: false });
  } catch (e) {
    console.warn('[angel] candles upstream exception: ' + redact(String(e.message || e)));
    return res.status(502).json({ error: 'upstream_error' });
  }
});

// POST /api/angel/encrypt
app.post('/api/angel/encrypt', angelCandlesLimiter, async (req, res) => {
  if (!isAngelAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
  const body = req.body || {};
  let plaintext = String(body.plaintext || body.text || body.data || '');
  if (!plaintext && body.creds) {
    try { plaintext = JSON.stringify(body.creds); } catch {}
  }
  if (!plaintext && typeof body === 'object' && (body.apiKey || body.clientCode || body.password || body.totpSecret)) {
    plaintext = JSON.stringify(body);
  }
  if (!plaintext) return res.status(400).json({ error: 'missing_plaintext' });
  try {
    const { encrypt } = require('./server/utils/encryption');
    const blob = encrypt(plaintext);
    return res.json({ blob });
  } catch (e) {
    console.warn('[angel] encrypt failed: ' + redact(String(e.message || e)));
    return res.status(400).json({ error: 'encrypt_failed' });
  }
});

// POST /api/angel/decrypt
app.post('/api/angel/decrypt', angelCandlesLimiter, async (req, res) => {
  if (!isAngelAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
  const body = req.body || {};
  const blob = String(body.blob || '');
  if (!blob) return res.status(400).json({ error: 'missing_blob' });
  try {
    const { decrypt } = require('./server/utils/encryption');
    const plaintext = decrypt(blob);
    return res.json({ plaintext });
  } catch (e) {
    console.warn('[angel] decrypt failed: ' + redact(String(e.message || e)));
    return res.status(400).json({ error: 'decrypt_failed' });
  }
});

app.post('/api/angel/decrypt-check', angelCandlesLimiter, async (req, res) => {
  if (!isAngelAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
  const body = req.body || {};
  const blob = String(body.blob || '');
  if (!blob) return res.status(400).json({ error: 'missing_blob' });
  try {
    const { decrypt } = require('./server/utils/encryption');
    decrypt(blob);
    return res.json({ ok: true });
  } catch (e) {
    console.warn('[angel] decrypt-check failed: ' + redact(String(e.message || e)));
    return res.status(400).json({ ok: false, error: 'decrypt_failed' });
  }
});


const LEGACY = PUBLIC_DIR.endsWith('public');
const PUBLIC_PATHS = new Set(LEGACY ? ['/login.html'] : []);
const SHELL_PATHS = new Set(['/', '/index.html', '/login.html', '/users.html']);
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (!LEGACY && req.path.startsWith('/assets/')) return next();
  // Dist SPA shell is served BEFORE the session check: the client router
  // renders Login for anonymous users, and dist/ has no login.html/users.html
  // files, so letting authenticated GETs fall through to express.static would
  // 404 ("Cannot GET /login.html") on every reload/bookmark after login.
  // {root} form: a bare absolute path made `send` fail with NotFound in some
  // environments while express.static served the very same file.
  if (!LEGACY && req.method === 'GET' && SHELL_PATHS.has(req.path)) {
    return res.sendFile('index.html', { root: PUBLIC_DIR });
  }
  if (req.session && req.session.user) return next();
  if (LEGACY) {
    if (req.path === '/' || req.path === '/index.html') return res.redirect('/login.html');
    return res.status(401).json({ error: 'unauthorized' });
  }
  return res.status(401).json({ error: 'unauthorized' });
});
// Worker assets: bounded client cache so each run doesn't revalidate
// worker.js + engine.js + robustness.js (importScripts refetches them per
// Worker construction). Filenames are unhashed, so the TTL is 1h — fresh
// deploys converge without a hard refresh; index.html stays uncached.
const ENGINE_ASSETS = new Set(['/worker.js', '/engine.js', '/robustness.js']);
app.use((req, res, next) => {
  if (ENGINE_ASSETS.has(req.path)) res.setHeader('Cache-Control', 'public, max-age=3600');
  next();
});
app.use(express.static(PUBLIC_DIR, { index: 'index.html', dotfiles: 'ignore' }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`[xbost] terminal live at http://localhost:${PORT} (login required)`));
}
module.exports = app;
