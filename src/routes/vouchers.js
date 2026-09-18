'use strict';
/* Anonymous customer surface: voucher activation + visit capture (no auth). */
const { Router } = require('express');
const crypto = require('crypto');
const { vnNow, uid } = require('../utils');
const { getDb, persist, audit, latestSnap } = require('../db/store');

function voucherRoutes() {
  const r = Router();

  r.post('/api/vouchers/activate', (req, res) => {
    const DB = getDb();
    const { code, deviceId } = req.body || {};
    const m = DB.media.find(x => x.code === code);
    if (!m || !m.active || m.revoked) return res.status(400).json({ error: 'Referral blocked' });
    const rq = m.referrerId ? DB.referrers.find(x => x.id === m.referrerId) : null;
    if (rq && rq.status !== 'approved') return res.status(400).json({ error: 'Referrer not approved' });
    const p = m.partnerId ? DB.partners.find(x => x.id === m.partnerId) : null;
    if (p && p.status !== 'active') return res.status(400).json({ error: 'Partner inactive' });
    if (!req.body.force) {
      const prior = DB.vouchers.find(v => v.mediaId === m.id && v.deviceId === deviceId
        && v.status === 'active' && new Date(v.expiresAt) > new Date());
      if (prior) return res.json({ ...prior, existing: true });
    }
    const snap = latestSnap(m);
    const ref = crypto.randomBytes(3).toString('hex').toUpperCase();
    const at = new Date(), exp = new Date(at.getTime() + 7 * 24 * 3600 * 1000);
    const v = {
      id: uid('v'), code: 'V-' + ref, ref, mediaId: m.id,
      attribution: {
        company: m.partnerId, location: m.locationId || null,
        affiliated: m.kind === 'personal' ? m.referrerId : null, medium: m.id,
      },
      snapshot: snap, status: 'active',
      activatedAt: at.toISOString(), expiresAt: exp.toISOString(), deviceId,
      contactPrefill: `Voucher ${ref} · ${snap.discountPct}% · exp ${exp.toISOString()}`,
    };
    DB.vouchers.push(v);
    DB.events.push({ k: 'open', code: m.code, at: vnNow(), dev: deviceId });
    audit('anonymous', 'voucher_activate', '', ref, m.partnerId, false);
    persist();
    res.json(v);
  });

  r.post('/api/events/open', (req, res) => {
    const DB = getDb();
    const { code, deviceId } = req.body || {};
    if (!DB.events.find(e => e.k === 'open' && e.code === code && e.dev === deviceId)) {
      DB.events.push({ k: 'open', code, at: vnNow(), dev: deviceId });
      persist();
    }
    res.json({ ok: true });
  });

  return r;
}

module.exports = { voucherRoutes };
