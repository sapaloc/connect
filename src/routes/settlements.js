'use strict';
const { Router } = require('express');
const { vnNow, uid } = require('../utils');
const { getDb, persist, audit } = require('../db/store');
const { auth } = require('../auth/middleware');
const { POLICY } = require('../auth/policy');

function settlementRoutes() {
  const r = Router();

  r.post('/api/settlements', auth, (req, res) => {
    if (!POLICY.settle.includes(req.auth.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const DB = getDb();
    const { itemIds, amount, ref, note, evidence, confirm } = req.body || {};
    if (!Array.isArray(itemIds) || !itemIds.length) {
      return res.status(400).json({ error: 'select items' });
    }
    if (!confirm) return res.status(400).json({ error: 'transfer confirmation required' });
    const items = itemIds.map(id => DB.redemptions.find(x => x.id === id)).filter(Boolean);
    if (items.length !== itemIds.length || items.some(x => x.voided || x.settlementId)) {
      return res.status(400).json({ error: 'items unavailable' });
    }
    const comps = new Set(items.map(x => (DB.vouchers.find(v => v.id === x.voucherId) || {}).attribution.company));
    if (comps.size !== 1) return res.status(400).json({ error: 'one recipient at a time' });
    const comp = [...comps][0];
    const coProf = DB.payouts.find(p => p.ownerId === comp);
    if (coProf && coProf.verified !== 'verified') {
      return res.status(400).json({ error: 'company payout profile unverified' });
    }
    const sum = items.reduce((s, x) => s + x.coComm + x.indComm, 0);
    const st = {
      id: uid('st'), items: itemIds, amount: Math.round(+amount || sum),
      date: vnNow(), payer: req.auth.userId, recipientId: comp,
      ref: ref || '', note: note || '', evidence: evidence === 'with' ? 'with' : 'without',
    };
    DB.settlements.push(st);
    items.forEach(x => { x.settlementId = st.id; });
    audit(req.auth.userId, 'settlement_paid', '', st.id + ':' + st.amount, comp, true);
    persist();
    res.json(st);
  });

  return r;
}

module.exports = { settlementRoutes };
