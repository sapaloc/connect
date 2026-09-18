'use strict';
const { Router } = require('express');
const { vnNow, uid } = require('../utils');
const { getDb, persist, audit } = require('../db/store');
const { auth } = require('../auth/middleware');
const { POLICY } = require('../auth/policy');

function payoutRoutes() {
  const r = Router();

  r.post('/api/payouts', auth, (req, res) => {
    const DB = getDb();
    const { ownerType, ownerId, bank, account, beneficiary, qr } = req.body || {};
    if (!beneficiary || !bank || !account) {
      return res.status(400).json({ error: 'beneficiary + bank + account required' });
    }
    const p = {
      id: uid('po'), ownerType: ownerType || 'company', ownerId: ownerId || 'p_saigon',
      bank, account, beneficiary, qr: qr || '',
      verified: 'pending', by: req.auth.userId, at: vnNow(),
    };
    DB.payouts.push(p);
    audit(req.auth.userId, 'payout_create', '', account, 'tenant', true);
    persist();
    res.json(p);
  });

  r.post('/api/payouts/:id/verify', auth, (req, res) => {
    const DB = getDb();
    const p = DB.payouts.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    if (p.ownerType === 'affiliated') {
      if (!POLICY.payout_verify_affil.includes(req.auth.role)) {
        return res.status(403).json({ error: 'Partner/Tenant admin required' });
      }
    } else if (!POLICY.payout_verify_company.includes(req.auth.role)) {
      return res.status(403).json({ error: 'Tenant admin required' });
    }
    p.verified = 'verified'; p.by = req.auth.userId; p.at = vnNow();
    audit(req.auth.userId, 'payout_verify', 'pending', 'verified', p.ownerId, true);
    persist();
    res.json(p);
  });

  return r;
}

module.exports = { payoutRoutes };
