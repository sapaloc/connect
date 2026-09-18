'use strict';
const { Router } = require('express');
const { vnNow, uid } = require('../utils');
const { getDb, persist, audit } = require('../db/store');
const { auth, need } = require('../auth/middleware');

function budgetRoutes() {
  const r = Router();

  r.post('/api/budgets', auth, need('budget_write'), (req, res) => {
    const DB = getDb();
    const { scopeId, total, discount, indivShare } = req.body || {};
    const tot = +total, d = +discount, s = +indivShare;
    if (!(tot > 0) || d < 5 || d >= tot) {
      return res.status(400).json({ error: 'min 5% discount, 0 < discount < total' });
    }
    const isInd = (DB.partners.find(p => p.id === scopeId) || {}).kind === 'individual';
    let rec;
    if (isInd) {
      if (d + s !== tot) {
        return res.status(400).json({ error: 'Independent: discount + indivComm must = total' });
      }
      rec = { id: uid('b'), scopeId, total: tot, discount: d, indivComm: s, by: req.auth.userId, at: vnNow(), futureOnly: true };
    } else {
      const net = tot - d - s;
      if (net < 0) return res.status(400).json({ error: 'Discount + share exceeds total' });
      rec = { id: uid('b'), scopeId, total: tot, discount: d, companyComm: tot - d, indivShare: s, companyNet: net, by: req.auth.userId, at: vnNow(), futureOnly: true };
    }
    DB.budgets.push(rec);
    audit(req.auth.userId, 'budget_version', '', rec.id, scopeId, true);
    persist();
    res.json(rec);
  });

  return r;
}

module.exports = { budgetRoutes };
