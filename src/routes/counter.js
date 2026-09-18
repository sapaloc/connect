'use strict';
/* Counter: authenticated voucher validation (no state change) + redemption. */
const { Router } = require('express');
const { vnNow, uid } = require('../utils');
const { getDb, persist, audit, calc } = require('../db/store');
const { auth } = require('../auth/middleware');
const { POLICY } = require('../auth/policy');

function counterRoutes() {
  const r = Router();

  r.post('/api/counter/validate', auth, (req, res) => {
    const DB = getDb();
    const v = DB.vouchers.find(x => x.ref === req.body.code || x.code === req.body.code);
    if (!v) return res.json({ verdict: 'invalid' });
    if (v.status === 'used') return res.json({ verdict: 'used' });
    if (new Date(v.expiresAt) < new Date() || v.status === 'expired') {
      return res.json({ verdict: 'expired' });
    }
    const p = DB.partners.find(x => x.id === v.attribution.company);
    res.json({
      verdict: 'valid', partner: p ? p.name : '',
      discountPct: v.snapshot.discountPct, expiresAt: v.expiresAt,
    });
  });

  r.post('/api/counter/redeem', auth, (req, res) => {
    if (!POLICY.counter_redeem.includes(req.auth.role)) {
      return res.status(403).json({ error: 'Staff/Manager login required' });
    }
    const DB = getDb();
    const v = DB.vouchers.find(x => x.ref === req.body.code || x.code === req.body.code);
    const gross = Math.round(+req.body.gross || 0);
    if (!v || v.status !== 'active') {
      return res.status(400).json({ error: 'Not redeemable (idempotent)' });
    }
    if (gross <= 0) return res.status(400).json({ error: 'gross > 0 required' });
    if (new Date(v.expiresAt) < new Date()) {
      v.status = 'expired'; persist();
      return res.status(400).json({ error: 'Expired' });
    }
    if (DB.redemptions.find(x => x.voucherId === v.id && !x.voided)) {
      return res.status(409).json({ error: 'Already redeemed (idempotent)' });
    }
    const c = calc(gross, v.snapshot);
    const red = { id: uid('r'), voucherId: v.id, ...c, staff: req.auth.userId, ts: vnNow(), voided: false };
    DB.redemptions.push(red);
    v.status = 'used';
    audit(req.auth.userId, 'redeem', v.ref, { gross: c.gross, pay: c.payable }, v.attribution.company, false);
    persist();
    res.json(red);
  });

  return r;
}

module.exports = { counterRoutes };
