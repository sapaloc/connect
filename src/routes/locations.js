'use strict';
const { Router } = require('express');
const { uid } = require('../utils');
const { getDb, persist, audit } = require('../db/store');
const { auth, need } = require('../auth/middleware');

function locationRoutes() {
  const r = Router();

  r.post('/api/locations', auth, need('location_write'), (req, res) => {
    const DB = getDb();
    const { partnerId, name, address, ward, referrerId } = req.body || {};
    if (!partnerId || !name || !address || !ward) {
      return res.status(400).json({ error: 'company + name + street + ward required' });
    }
    if (referrerId) {
      const ref = DB.referrers.find(x => x.id === referrerId);
      if (!ref || ref.partnerId !== partnerId) {
        return res.status(400).json({ error: 'Referrer must belong to selected company' });
      }
      if (DB.locations.some(l => l.referrerId === referrerId)) {
        return res.status(400).json({ error: 'Referrer already assigned' });
      }
    }
    const l = { id: uid('l'), partnerId, name, address, ward, referrerId: referrerId || '' };
    DB.locations.push(l);
    audit(req.auth.userId, 'location_create', '', l.id, partnerId, true);
    persist();
    res.json(l);
  });

  r.delete('/api/locations/:id', auth, need('location_write'), (req, res) => {
    const DB = getDb();
    DB.locations = DB.locations.filter(x => x.id !== req.params.id);
    audit(req.auth.userId, 'location_delete', req.params.id, '', 'tenant', true);
    persist();
    res.json({ ok: true });
  });

  return r;
}

module.exports = { locationRoutes };
