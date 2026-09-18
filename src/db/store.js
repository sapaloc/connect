'use strict';
/* File-NoSQL store: load-once DB singleton, debounced atomic persist,
   append-style audit, scheduled relationship end-date processing,
   Net/Net financial math (integer VND). */
const fs = require('fs');
const { DATA_FILE } = require('../config');
const { vnNow, uid } = require('../utils');
const { seedDb } = require('./seed');

let DB;
try {
  if (fs.existsSync(DATA_FILE)) DB = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  else { DB = seedDb(); fs.writeFileSync(DATA_FILE, JSON.stringify(DB, null, 2)); }
} catch (e) {
  console.error('data.json corrupt, reseeding', e.message);
  DB = seedDb();
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(DB, null, 2));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) { console.error('persist failed', e.message); }
  }, 150);
}

function getDb() { return DB; }

function audit(actor, action, prev, next, scope, internal, note) {
  DB.audits.push({
    id: uid('a'), ts: vnNow(), actor, action,
    prev: String(prev ?? '').slice(0, 800),
    next: String(next ?? '').slice(0, 800),
    scope: scope || 'tenant', internal: internal !== false, note: note || ''
  });
  if (DB.audits.length > 5000) DB.audits = DB.audits.slice(-5000);
  persist();
}

function autoEnd() {
  const today = new Date().toISOString().slice(0, 10);
  DB.partners.forEach(p => {
    if (p.validTo && p.validTo < today && ['active', 'paused'].includes(p.status)) {
      const prev = p.status; p.status = 'ended';
      audit('system', 'partner_auto_end', prev, 'ended', p.id, true, 'validTo ' + p.validTo);
    }
  });
}

/* finance: discount -> payable -> VAT removal -> netNet -> commissions (VND ints) */
function calc(gross, snap) {
  gross = Math.round(+gross || 0);
  const vat = +DB.settings.vat || 0, d = +snap.discountPct || 0;
  const discount = Math.round(gross * d / 100);
  const payable = gross - discount;
  const netNet = Math.round(payable * 100 / (100 + vat));
  const vatAmt = payable - netNet;
  const coComm = Math.round(netNet * (+snap.companyComm || 0) / 100);
  const indComm = Math.round(netNet * ((snap.indivComm != null ? snap.indivComm : snap.indivShare) || 0) / 100);
  return { gross, discount, payable, vat, vatAmt, netNet, coComm, indComm };
}

function latestSnap(media) {
  const b = [...DB.budgets].reverse().find(x => x.scopeId === (media && media.partnerId))
    || { discount: 10, companyComm: 10, indivShare: 4, total: 20 };
  return {
    discountPct: b.discount, companyComm: b.companyComm || 0,
    indivShare: b.indivShare || b.indivComm || 0, indivComm: b.indivComm,
    total: b.total, budgetId: b.id
  };
}

function withoutPass(u) { const { pass, ...safe } = u; return safe; }

module.exports = { getDb, persist, audit, autoEnd, calc, latestSnap, withoutPass };
