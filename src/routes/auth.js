'use strict';
const { Router } = require('express');
const crypto = require('crypto');
const { vnNow } = require('../utils');
const { getDb, persist, audit, withoutPass } = require('../db/store');
const { rateBlocked, hitRate, clearRate, sessions, auth } = require('../auth/middleware');

function authRoutes() {
  const r = Router();

  r.post('/api/auth/login', (req, res) => {
    const DB = getDb();
    const { email, pass, role, supportReason } = req.body || {};
    const em = String(email || '').trim().toLowerCase();
    if (rateBlocked(em)) return res.status(429).json({ error: 'Rate limited — try in 5 min' });
    const u = DB.users.find(x => x.email === em && x.active);
    if (!u || u.pass !== pass) {
      hitRate(em);
      audit(em, 'signin_failed', '', '', 'tenant', true);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    clearRate(em);
    const rl = role || u.roles[0];
    if (!u.roles.includes(rl)) return res.status(403).json({ error: 'Role not assigned to this user' });
    let scope = 'tenant';
    if (rl === 'partner_admin') scope = u.partnerId || (DB.partners[0] && DB.partners[0].id);
    if (rl === 'referrer') scope = u.referrerId || '';
    if (rl === 'platform_admin') {
      if (!String(supportReason || '').trim()) return res.status(400).json({ error: 'Support reason required' });
      audit(u.id, 'support_access', '', 'tenant (reason: ' + supportReason + ')', 'tenant', true);
    }
    const token = crypto.randomBytes(24).toString('hex');
    sessions().push({
      token, userId: u.id, role: rl, scope,
      support: rl === 'platform_admin', supportReason: supportReason || '', ts: vnNow(),
    });
    audit(u.id, 'signin', '', rl + '/' + scope, 'tenant', true);
    persist();
    res.json({ token, user: withoutPass(u), role: rl, scope });
  });

  r.post('/api/auth/logout', auth, (req, res) => {
    const DB = getDb();
    DB.sessions = sessions().filter(x => x.token !== req.auth.token);
    audit(req.auth.userId, 'signout', '', '', 'tenant', true);
    persist();
    res.json({ ok: true });
  });

  r.get('/api/me', auth, (req, res) => {
    res.json({ user: withoutPass(req.auth.user), role: req.auth.role, scope: req.auth.scope });
  });

  return r;
}

module.exports = { authRoutes };
