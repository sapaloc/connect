'use strict';
/* Microsite catalog + tenant settings + invites/resets. */
const { Router } = require('express');
const { vnNow, uid } = require('../utils');
const { getDb, persist, audit } = require('../db/store');
const { auth, need } = require('../auth/middleware');

function catalogRoutes() {
  const r = Router();

  r.post('/api/services', auth, need('content_write'), (req, res) => {
    const DB = getDb();
    const s = {
      id: uid('s'), en: req.body.en || 'New', vi: req.body.vi || 'Mới',
      dur: +req.body.dur || 60, price: +req.body.price || 500000, img: req.body.img || '', hl: false,
    };
    DB.services.push(s);
    audit(req.auth.userId, 'content_add', '', s.id, 'tenant', true);
    persist();
    res.json(s);
  });

  r.post('/api/services/:id/highlight', auth, need('content_write'), (req, res) => {
    const DB = getDb();
    const s = DB.services.find(x => x.id === req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    s.hl = !s.hl;
    persist();
    res.json(s);
  });

  r.put('/api/site', auth, need('content_write'), (req, res) => {
    const DB = getDb();
    Object.assign(DB.site, req.body || {});
    audit(req.auth.userId, 'content_contacts', '', 'saved', 'tenant', true);
    persist();
    res.json(DB.site);
  });

  r.put('/api/settings', auth, need('settings'), (req, res) => {
    const DB = getDb();
    if (req.body.vat != null) DB.settings.vat = Math.round(+req.body.vat || 8);
    if (req.body.lang) DB.settings.lang = req.body.lang;
    audit(req.auth.userId, 'settings', '', 'vat ' + DB.settings.vat, 'tenant', true);
    persist();
    res.json(DB.settings);
  });

  r.post('/api/invites', auth, (req, res) => {
    const DB = getDb();
    const inv = { email: req.body.email, by: req.auth.userId, at: vnNow(), token: uid('tok') };
    DB.invites.push(inv);
    audit(req.auth.userId, 'invite', '', inv.email, 'tenant', true);
    persist();
    res.json(inv);
  });

  r.post('/api/resets', auth, (req, res) => {
    const DB = getDb();
    const rst = {
      email: req.body.email, at: vnNow(),
      token: uid('rst'), exp: new Date(Date.now() + 3600e3).toISOString(),
    };
    DB.resets.push(rst);
    audit(req.auth.userId, 'reset', '', rst.email, 'tenant', true);
    persist();
    res.json(rst);
  });

  return r;
}

module.exports = { catalogRoutes };
