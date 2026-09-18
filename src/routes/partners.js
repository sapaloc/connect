'use strict';
const { Router } = require('express');
const { vnNow, uid } = require('../utils');
const { getDb, persist, audit } = require('../db/store');
const { auth, need } = require('../auth/middleware');

function partnerRoutes() {
  const r = Router();

  r.post('/api/partners', auth, need('partner_create'), (req, res) => {
    const DB = getDb();
    const { kind, name, contact, email, phone, ptype } = req.body || {};
    if (!name || !contact || (!email && !phone)) {
      return res.status(400).json({ error: 'name + contact + (email|phone) required' });
    }
    const p = {
      id: uid('p'), kind: kind === 'individual' ? 'individual' : 'company', name,
      ptype: kind === 'individual' ? 'independent' : (ptype || 'Hotel'),
      owner: req.auth.userId, contact, email: email || '', phone: phone || '',
      status: 'onboarding', validFrom: new Date().toISOString().slice(0, 10), validTo: '', note: '',
    };
    DB.partners.push(p);
    audit(req.auth.userId, 'partner_create', '', p.id, 'tenant', true);
    persist();
    res.json(p);
  });

  r.post('/api/partners/:id/transition', auth, need('partner_approve'), (req, res) => {
    const DB = getDb();
    const p = DB.partners.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const to = req.body.to;
    if (to === 'active' && p.kind === 'company'
      && ['Hotel', 'Restaurant', 'Spa'].includes(p.ptype || 'Hotel')
      && !DB.locations.some(l => l.partnerId === p.id)) {
      return res.status(400).json({ error: 'Require a location before activating location-based partner type' });
    }
    const prev = p.status; p.status = to;
    if (to === 'active') { p.approver = req.auth.userId; p.approvedAt = vnNow(); }
    audit(req.auth.userId, 'partner_' + to, prev, to, p.id, true);
    persist();
    res.json(p);
  });

  return r;
}

module.exports = { partnerRoutes };
