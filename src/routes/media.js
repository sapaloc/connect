'use strict';
const { Router } = require('express');
const crypto = require('crypto');
const { uid } = require('../utils');
const { getDb, persist, audit } = require('../db/store');
const { auth, need } = require('../auth/middleware');

function mediaRoutes() {
  const r = Router();

  r.post('/api/media', auth, need('media_write'), (req, res) => {
    const DB = getDb();
    const { locationId } = req.body || {};
    if (locationId && !DB.locations.find(l => l.id === locationId)) {
      return res.status(400).json({ error: 'real location only' });
    }
    const loc = locationId ? DB.locations.find(l => l.id === locationId) : null;
    const m = {
      id: uid('m'), kind: loc ? 'location' : 'company',
      partnerId: loc ? loc.partnerId : (req.body.partnerId || 'p_saigon'),
      locationId: locationId || undefined,
      code: 'SAPAWO-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
      active: true, revoked: false,
    };
    DB.media.push(m);
    audit(req.auth.userId, 'media_create', '', m.code, m.partnerId, true);
    persist();
    res.json(m);
  });

  r.post('/api/media/:id/replace', auth, need('media_write'), (req, res) => {
    const DB = getDb();
    const m = DB.media.find(x => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    m.revoked = true; m.active = false;
    const nm = {
      id: uid('m'), kind: m.kind, partnerId: m.partnerId,
      referrerId: m.referrerId, locationId: m.locationId,
      code: m.code + '-R2', active: true, revoked: false,
    };
    DB.media.push(nm);
    audit(req.auth.userId, 'media_replace', m.code, nm.code, m.partnerId, true);
    persist();
    res.json(nm);
  });

  r.post('/api/media/:id/block', auth, need('media_write'), (req, res) => {
    const DB = getDb();
    const m = DB.media.find(x => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    m.active = false;
    audit(req.auth.userId, 'media_block', m.code, 'blocked', m.partnerId, true);
    persist();
    res.json(m);
  });

  return r;
}

module.exports = { mediaRoutes };
