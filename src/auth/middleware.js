'use strict';
/* Session auth, login rate limiting, RBAC guard, tenant-scope helper. */
const { SESSION_TTL_MS, RATE_WINDOW_MS, RATE_MAX } = require('../config');
const { getDb, persist } = require('../db/store');
const { POLICY } = require('./policy');

const attempts = {}; // email -> {n,t}

function rateBlocked(email) {
  const a = attempts[email];
  if (!a) return false;
  if (Date.now() - a.t > RATE_WINDOW_MS) { delete attempts[email]; return false; }
  return a.n >= RATE_MAX;
}

function hitRate(email) {
  attempts[email] = { n: ((attempts[email] || {}).n || 0) + 1, t: Date.now() };
}

function clearRate(email) { delete attempts[email]; }

function sessions() {
  const DB = getDb();
  DB.sessions = DB.sessions || [];
  return DB.sessions;
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ')
    ? h.slice(7)
    : (req.query.token || (req.body && req.body.token));
  const s = sessions().find(x => x.token === tok);
  if (!s) return res.status(401).json({ error: 'unauthorized' });
  if (Date.now() - new Date(s.ts).getTime() > SESSION_TTL_MS) {
    const DB = getDb();
    DB.sessions = sessions().filter(x => x.token !== tok);
    persist();
    return res.status(401).json({ error: 'session expired' });
  }
  const user = getDb().users.find(u => u.id === s.userId && u.active);
  if (!user) return res.status(401).json({ error: 'user inactive' });
  req.auth = { ...s, user };
  next();
}

function need(key) {
  return (req, res, next) => {
    if (!(POLICY[key] || []).includes(req.auth.role)) {
      return res.status(403).json({ error: 'forbidden for role ' + req.auth.role });
    }
    next();
  };
}

function scopePartners(req) {
  if (req.auth.role === 'partner_admin') return [req.auth.scope];
  if (req.auth.role === 'referrer') {
    const r = getDb().referrers.find(x => x.id === req.auth.scope);
    return r ? [r.partnerId] : [];
  }
  return null; // tenant-wide
}

module.exports = { attempts, rateBlocked, hitRate, clearRate, sessions, auth, need, scopePartners };
