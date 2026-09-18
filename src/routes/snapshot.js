'use strict';
/* Reads: full scoped snapshot, generic collections, site, settings.
   NOTE: specific GETs (/api/site, /api/settings) must be registered BEFORE
   the generic /api/:col route or Express will swallow them as :col='site'. */
const { Router } = require('express');
const { getDb, withoutPass } = require('../db/store');
const { auth, scopePartners } = require('../auth/middleware');

const COLS = ['partners', 'locations', 'referrers', 'budgets', 'media', 'cards',
  'services', 'vouchers', 'redemptions', 'payouts', 'settlements', 'audits',
  'events', 'invites', 'resets', 'users'];

function scopedList(DB, req, col) {
  let list = DB[col] || [];
  const sc = scopePartners(req);
  if (sc && ['partners', 'referrers', 'locations', 'media'].includes(col)) {
    const key = col === 'partners' ? null : 'partnerId';
    list = key ? list.filter(x => sc.includes(x[key])) : list.filter(x => sc.includes(x.id));
  }
  if (col === 'users') list = list.map(withoutPass);
  if (col === 'audits' && ['partner_admin', 'referrer'].includes(req.auth.role)) {
    list = list.filter(a => !a.internal);
  }
  return list;
}

function snapshotRoutes() {
  const r = Router();

  // Full scoped snapshot (frontend boot + sync)
  r.get('/api/db', auth, (req, res) => {
    const DB = getDb();
    const clone = JSON.parse(JSON.stringify(DB));
    clone.users = clone.users.map(withoutPass);
    const sc = scopePartners(req);
    if (sc) {
      clone.partners = clone.partners.filter(p => sc.includes(p.id));
      clone.referrers = clone.referrers.filter(x => sc.includes(x.partnerId));
      clone.locations = clone.locations.filter(x => sc.includes(x.partnerId));
      clone.media = clone.media.filter(x => sc.includes(x.partnerId));
    }
    if (['partner_admin', 'referrer'].includes(req.auth.role)) {
      clone.audits = clone.audits.filter(a => !a.internal);
    }
    res.json(clone);
  });

  // Specific reads first (see note above)
  r.get('/api/site', (req, res) => res.json(getDb().site));
  r.get('/api/settings', auth, (req, res) => res.json(getDb().settings));

  // Generic collection read (scope-filtered for partner roles)
  r.get('/api/:col', auth, (req, res) => {
    if (!COLS.includes(req.params.col)) return res.status(404).json({ error: 'unknown collection' });
    res.json(scopedList(getDb(), req, req.params.col));
  });

  return r;
}

module.exports = { snapshotRoutes, COLS };
