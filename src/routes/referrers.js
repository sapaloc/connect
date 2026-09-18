'use strict';
const { Router } = require('express');
const crypto = require('crypto');
const { uid, vnNow } = require('../utils');
const { getDb, persist, audit } = require('../db/store');
const { auth } = require('../auth/middleware');
const { POLICY } = require('../auth/policy');

function referrerRoutes() {
  const r = Router();

  r.post('/api/referrers', auth, (req, res, next) => {
    if (!POLICY.referrer_submit.includes(req.auth.role)) {
      return res.status(403).json({ error: 'forbidden for role ' + req.auth.role });
    }
    next();
  }, (req, res) => {
    const DB = getDb();
    const pid = (req.auth.scope && String(req.auth.scope).startsWith('p_'))
      ? req.auth.scope
      : (req.body.partnerId || 'p_saigon');
    const co = DB.partners.find(p => p.id === pid);
    const ref = {
      id: uid('r'), kind: 'affiliated', name: req.body.name, rtype: req.body.rtype || 'Staff',
      affiliation: 'employed', partnerId: pid, owner: co ? co.owner : req.auth.userId,
      status: 'pending', phone: '', position: '',
    };
    if (!ref.name) return res.status(400).json({ error: 'name required' });
    DB.referrers.push(ref);
    audit(req.auth.userId, 'referrer_submit', '', ref.name, pid, true);
    persist();
    res.json(ref);
  });

  r.post('/api/referrers/:id/transition', auth, (req, res) => {
    const DB = getDb();
    const ref = DB.referrers.find(x => x.id === req.params.id);
    if (!ref) return res.status(404).json({ error: 'not found' });
    const to = req.body.to;
    if (['approved', 'rejected'].includes(to) && !POLICY.referrer_approve.includes(req.auth.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (to === 'ended' && !POLICY.referrer_end.includes(req.auth.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (to === 'rejected') {
      if (!req.body.reason) return res.status(400).json({ error: 'Partner-facing reason required' });
      ref.rejectReason = req.body.reason;
      ref.rejectNoteInternal = req.body.note || '';
    }
    const prev = ref.status;
    if (to === 'approved' && ref.kind === 'affiliated') {
      const co = DB.partners.find(p => p.id === ref.partnerId);
      if (co) ref.owner = co.owner;
      if (!DB.media.find(m => m.referrerId === ref.id && m.kind === 'personal')) {
        DB.media.push({
          id: uid('m'), kind: 'personal', partnerId: ref.partnerId, referrerId: ref.id,
          code: 'SAPAWO-' + ref.name.slice(0, 2).toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase(),
          active: true, revoked: false,
        });
      }
    }
    if (to === 'ended') {
      DB.media.filter(m => m.referrerId === ref.id).forEach(m => { m.active = false; });
      DB.cards
        .filter(c => c.referrerId === ref.id && !['blocked', 'replaced'].includes(c.status))
        .forEach(c => { c.status = 'blocked'; c.history.push({ s: 'blocked', at: vnNow(), by: req.auth.userId }); });
    }
    ref.status = to;
    audit(req.auth.userId, 'referrer_' + to, prev, to, ref.partnerId, to !== 'rejected');
    persist();
    res.json(ref);
  });

  return r;
}

module.exports = { referrerRoutes };
