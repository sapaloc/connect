'use strict';
const { Router } = require('express');
const { vnNow, uid } = require('../utils');
const { getDb, persist, audit } = require('../db/store');
const { auth, need } = require('../auth/middleware');
const { POLICY } = require('../auth/policy');

function cardRoutes() {
  const r = Router();

  r.post('/api/cards', auth, (req, res) => {
    if (!POLICY.card_request.includes(req.auth.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const DB = getDb();
    const c = {
      id: uid('c'),
      partnerId: (req.auth.scope && String(req.auth.scope).startsWith('p_')) ? req.auth.scope : 'p_saigon',
      referrerId: req.auth.role === 'referrer' ? req.auth.scope : (req.body.referrerId || 'r_an'),
      status: 'requested', funding: req.body.funding || 'free',
      requester: req.auth.userId,
      history: [{ s: 'requested', at: vnNow(), by: req.auth.userId }],
    };
    DB.cards.push(c);
    audit(req.auth.userId, 'card_request', '', c.id, c.partnerId, true);
    persist();
    res.json(c);
  });

  r.post('/api/cards/:id/transition', auth, need('card_approve'), (req, res) => {
    const DB = getDb();
    const c = DB.cards.find(x => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    const order = {
      requested: ['approved', 'rejected'], approved: ['in_production'],
      in_production: ['delivered'], delivered: ['blocked', 'replaced'], blocked: ['replaced'],
    };
    if (!(order[c.status] || []).includes(req.body.to)) {
      return res.status(400).json({ error: 'Illegal transition' });
    }
    const prev = c.status; c.status = req.body.to;
    c.history.push({ s: c.status, at: vnNow(), by: req.auth.userId });
    if (c.status === 'approved') c.approver = req.auth.userId;
    audit(req.auth.userId, 'card_' + c.status, prev, c.status, c.partnerId, true);
    persist();
    res.json(c);
  });

  return r;
}

module.exports = { cardRoutes };
