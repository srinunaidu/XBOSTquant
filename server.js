/* XBOST server — session-auth gateway in front of the static terminal.
 * Public:  /login.html, /api/login
 * Guarded: everything else (terminal, engine, data) requires a login session.
 * Users live in SQLite (users.db). Admin bootstrap via ADMIN_USER/ADMIN_PASS.
 */
'use strict';
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');

const PORT = process.env.PORT || 8901;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'users.db');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || 'xbost-dev-secret-change-me';

if (!process.env.SESSION_SECRET) console.warn('[auth] SESSION_SECRET not set — using dev default. Set it in production.');
if (!process.env.ADMIN_PASS) console.warn('[auth] ADMIN_PASS not set — admin password is "changeme". Change it on first login.');

const db = new Database(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
)`);

// bootstrap admin
const adminRow = db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN_USER);
if (!adminRow) {
  db.prepare("INSERT INTO users (username, pass_hash, role, active, created_at) VALUES (?, ?, 'admin', 1, datetime('now'))")
    .run(ADMIN_USER, bcrypt.hashSync(ADMIN_PASS, 10));
  console.log(`[auth] bootstrap admin user "${ADMIN_USER}" created`);
}

const app = express();
app.use(express.json({ limit: '100kb' }));
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
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());
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

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'unauthorized' });
  res.json({ user: req.session.user });
});

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'unauthorized' });
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  next();
}

const pubUser = r => ({ id: r.id, username: r.username, role: r.role, active: !!r.active, created_at: r.created_at });
app.get('/api/users', requireAdmin, (req, res) => {
  res.json({ users: db.prepare('SELECT * FROM users ORDER BY id').all().map(pubUser) });
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(name)) return res.status(400).json({ error: 'Username: 3-32 chars, letters/digits/._-' });
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'Password: minimum 8 characters.' });
  const r = role === 'admin' ? 'admin' : 'user';
  try {
    const info = db.prepare("INSERT INTO users (username, pass_hash, role, active, created_at) VALUES (?, ?, ?, 1, datetime('now'))")
      .run(name, bcrypt.hashSync(String(password), 10), r);
    res.status(201).json({ ok: true, user: pubUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)) });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists.' });
    throw e;
  }
});

app.patch('/api/users/:id', requireAdmin, (req, res) => {
  const id = +req.params.id;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  const me = req.session.user;
  const { active, password, role } = req.body || {};
  if (target.id === me.id && active === false) return res.status(400).json({ error: 'Cannot deactivate yourself.' });
  if (target.id === me.id && role && role !== 'admin') return res.status(400).json({ error: 'Cannot demote yourself.' });
  if (active !== undefined) db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  if (password !== undefined) {
    if (String(password).length < 8) return res.status(400).json({ error: 'Password: minimum 8 characters.' });
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(password), 10), id);
  }
  if (role !== undefined) {
    if (target.id === me.id) return res.status(400).json({ error: 'Cannot change your own role.' });
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role === 'admin' ? 'admin' : 'user', id);
  }
  res.json({ ok: true, user: pubUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
});

// ---- gate: login page + APIs public, everything else needs a session ----
const PUBLIC_PATHS = new Set(['/login.html']);
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (req.session && req.session.user) return next();
  if (req.path === '/' || req.path === '/index.html') return res.redirect('/login.html');
  return res.status(401).json({ error: 'unauthorized' });
});
app.use(express.static(PUBLIC_DIR, { index: 'index.html', dotfiles: 'ignore' }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`[xbost] terminal live at http://localhost:${PORT} (login required)`));
}
module.exports = app;
