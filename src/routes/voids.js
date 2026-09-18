'use strict';
const { Router } = require('express');
const { vnNow } = require('../utils');
const { getDb, persist, audit } = require('../db/store');
const { auth, need } = require('../auth/middleware');

function voidRoutes() {
  const r = Router();

  r.post('/api/redemptions/:id/void', auth, need('void'), (req, res) => {
    const DB = getDb();
    const red = DB.redemptions.find(x => x.id === req.params.id);
    if (!red) return res.status(404).json({ error: 'not found' });
    if (red.settlementId) {
      return res.status(400).json({ error: 'In Paid settlement — outside V1' });
    }
    if (!req.body.reason) return res.status(400).json({ error: 'reason required' });
    red.voided = true;
    red.voidReason = req.body.reason;
    red.voidBy = req.auth.userId;
    red.voidAt = vnNow();
    red.reversal = { ts: red.voidAt, by: red.voidBy, reason: req.body.reason };
    const v = DB.vouchers.find(x => x.id === red.voucherId);
    if (v) v.status = new Date(v.expiresAt) < new Date() ? 'expired' : 'active';
    audit(req.auth.userId, 'void', red.id, req.body.reason, 'tenant', true);
    persist();
    res.json(red);
  });

  return r;
}

module.exports = { voidRoutes };
