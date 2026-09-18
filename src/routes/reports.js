'use strict';
const { Router } = require('express');
const { getDb } = require('../db/store');
const { auth } = require('../auth/middleware');

function reportRoutes() {
  const r = Router();

  r.get('/api/reports/funnel', auth, (req, res) => {
    const DB = getDb();
    const o = DB.events.filter(e => e.k === 'open').length, a = DB.vouchers.length;
    const reds = DB.redemptions.filter(x => !x.voided);
    res.json({
      opens: o, activations: a, redemptions: reds.length,
      revenue: reds.reduce((s, x) => s + x.gross, 0),
      commission: reds.reduce((s, x) => s + x.coComm + x.indComm, 0),
      paid: DB.settlements.reduce((s, x) => s + x.amount, 0),
    });
  });

  return r;
}

module.exports = { reportRoutes };
