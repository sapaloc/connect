/* Connect backend — Express + file NoSQL (data.json)
   Total solution: serves REST API under /api/* AND the frontend static files.
   Run:  cd backend && npm install && npm start   →  http://localhost:3000
*/
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const FRONT_DIR = path.join(__dirname, '..', 'frontend');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

/* ---------------- file NoSQL ---------------- */
function vnNow() { return new Date().toISOString(); }
function uid(p) { return (p || 'id') + '_' + crypto.randomBytes(4).toString('hex') + Date.now().toString(36).slice(-4); }

function seedDb() {
  return {
    users: [
      { id: 'u_platform', email: 'platform@sapawoo.vn', pass: 'admin123', name: 'Platform Admin', roles: ['platform_admin'], active: true },
      { id: 'u_tenant', email: 'tenant@sapawoo.vn', pass: 'admin123', name: 'Tenant Admin', roles: ['tenant_admin'], active: true },
      { id: 'u_mgr', email: 'manager@number160.vn', pass: 'staff123', name: 'Number160 Manager', roles: ['manager160'], active: true },
      { id: 'u_staff', email: 'staff@number160.vn', pass: 'staff123', name: 'Number160 Staff', roles: ['staff160'], active: true },
      { id: 'u_partner', email: 'partner@company.vn', pass: 'partner123', name: 'Partner Admin (Saigon Eats)', roles: ['partner_admin'], partnerId: 'p_saigon', active: true },
      { id: 'u_ref', email: 'referrer@company.vn', pass: 'ref123', name: 'An Nguyen (Referrer)', roles: ['referrer'], referrerId: 'r_an', active: true }
    ],
    invites: [], resets: [], sessions: [],
    partners: [
      { id: 'p_saigon', kind: 'company', name: 'Saigon Eats Co.', ptype: 'Hotel', owner: 'u_tenant', contact: 'Linh Tran', email: 'hello@saigoneats.vn', phone: '0901234567', status: 'active', approver: 'u_tenant', approvedAt: vnNow(), validFrom: '2026-01-01', validTo: '2027-01-01', note: 'Pilot partner' },
      { id: 'p_ind1', kind: 'individual', name: 'Independent: Minh Chau', ptype: 'independent', owner: 'u_tenant', contact: 'Minh Chau', email: '', phone: '0912345678', status: 'active', approver: 'u_tenant', approvedAt: vnNow(), validFrom: '2026-02-01', validTo: '', note: '' }
    ],
    locations: [{ id: 'l_1', partnerId: 'p_saigon', name: 'Saigon Eats D1', address: '160 Dong Khoi', ward: 'Ben Nghe, D1', referrerId: 'r_an' }],
    referrers: [
      { id: 'r_an', kind: 'affiliated', name: 'An Nguyen', rtype: 'Concierge', affiliation: 'employed', partnerId: 'p_saigon', locationId: 'l_1', owner: 'u_tenant', email: '', phone: '0909998888', position: 'Concierge (role, not location)', status: 'approved', note: '' },
      { id: 'r_ind1', kind: 'independent', name: 'Minh Chau', rtype: 'KOL', affiliation: 'independent', partnerId: 'p_ind1', owner: 'u_tenant', status: 'approved', phone: '0912345678' }
    ],
    budgets: [
      { id: 'b_1', scopeId: 'p_saigon', total: 20, discount: 10, companyComm: 10, indivShare: 4, companyNet: 6, by: 'u_tenant', at: vnNow(), futureOnly: true },
      { id: 'b_2', scopeId: 'p_ind1', total: 20, discount: 10, indivComm: 10, by: 'u_tenant', at: vnNow(), futureOnly: true }
    ],
    media: [
      { id: 'm_co', kind: 'company', partnerId: 'p_saigon', code: 'SAPAWO-CO-SAIGON', active: true, revoked: false },
      { id: 'm_loc', kind: 'location', partnerId: 'p_saigon', locationId: 'l_1', code: 'SAPAWO-LOC-D1', active: true, revoked: false },
      { id: 'm_an', kind: 'personal', partnerId: 'p_saigon', referrerId: 'r_an', code: 'SAPAWO-AN-88', active: true, revoked: false }
    ],
    cards: [{ id: 'c_1', partnerId: 'p_saigon', referrerId: 'r_an', status: 'delivered', funding: 'free', requester: 'u_partner', approver: 'u_tenant', history: [{ s: 'requested', at: vnNow(), by: 'u_partner' }, { s: 'approved', at: vnNow(), by: 'u_tenant' }, { s: 'delivered', at: vnNow(), by: 'u_tenant' }] }],
    services: [
      { id: 's1', en: 'Signature Body Massage 60m', vi: 'Massage body đặc trưng 60p', dur: 60, price: 850000, img: '', hl: true },
      { id: 's2', en: 'Deep Tissue 90m', vi: 'Massage sâu 90p', dur: 90, price: 1200000, img: '', hl: true },
      { id: 's3', en: 'Facial Glow 60m', vi: 'Chăm sóc da 60p', dur: 60, price: 950000, img: '', hl: true },
      { id: 's4', en: 'Foot Ritual 45p', vi: 'Liệu trình chân 45p', dur: 45, price: 550000, img: '', hl: true },
      { id: 's5', en: 'Hot Stone 75m', vi: 'Đá nóng 75p', dur: 75, price: 1100000, img: '', hl: false }
    ],
    site: { logo: '', zalo: '0901600160', whatsapp: '+84901600160', trust_en: 'Licensed therapists · Hygienic · Since 2016', trust_vi: 'KTV chuyên nghiệp · Vệ sinh · Từ 2016', loc_en: '160 Dong Khoi, D1, HCMC', loc_vi: '160 Đồng Khởi, Q1, TP.HCM', published: true, hero_en: 'Exclusive member benefit via our partner', hero_vi: 'Ưu đãi độc quyền qua đối tác' },
    vouchers: [], redemptions: [],
    payouts: [
      { id: 'po_co', ownerType: 'company', ownerId: 'p_saigon', bank: 'Vietcombank', account: '0071001234567', beneficiary: 'SAIGON EATS CO', qr: '', verified: 'verified', by: 'u_tenant', at: vnNow() },
      { id: 'po_an', ownerType: 'affiliated', ownerId: 'r_an', bank: 'Techcombank', account: '19012345678', beneficiary: 'NGUYEN VAN AN', qr: '', verified: 'verified', by: 'u_partner', at: vnNow() }
    ],
    settlements: [],
    audits: [{ id: 'a_seed', ts: vnNow(), actor: 'system', action: 'seed', prev: '', next: 'db init', scope: 'tenant', internal: true }],
    events: [],
    settings: { vat: 8, lang: 'en', supportReason: '' }
  };
}

let DB;
try {
  if (fs.existsSync(DATA_FILE)) DB = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  else { DB = seedDb(); fs.writeFileSync(DATA_FILE, JSON.stringify(DB, null, 2)); }
} catch (e) { console.error('data.json corrupt, reseeding', e.message); DB = seedDb(); }

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

function audit(actor, action, prev, next, scope, internal, note) {
  DB.audits.push({ id: uid('a'), ts: vnNow(), actor, action, prev: String(prev ?? '').slice(0, 800), next: String(next ?? '').slice(0, 800), scope: scope || 'tenant', internal: internal !== false, note: note || '' });
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
autoEnd();
setInterval(autoEnd, 60 * 60 * 1000);

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
  const b = [...DB.budgets].reverse().find(x => x.scopeId === (media && media.partnerId)) || { discount: 10, companyComm: 10, indivShare: 4, total: 20 };
  return { discountPct: b.discount, companyComm: b.companyComm || 0, indivShare: b.indivShare || b.indivComm || 0, indivComm: b.indivComm, total: b.total, budgetId: b.id };
}

/* ---------------- auth ---------------- */
const attempts = {}; // email -> {n,t}
function rateBlocked(email) {
  const a = attempts[email];
  if (!a) return false;
  if (Date.now() - a.t > 5 * 60 * 1000) { delete attempts[email]; return false; }
  return a.n >= 5;
}
function sessions() { DB.sessions = DB.sessions || []; return DB.sessions; }
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || (req.body && req.body.token));
  const s = sessions().find(x => x.token === tok);
  if (!s) return res.status(401).json({ error: 'unauthorized' });
  if (Date.now() - new Date(s.ts).getTime() > 8 * 3600 * 1000) {
    DB.sessions = sessions().filter(x => x.token !== tok); persist();
    return res.status(401).json({ error: 'session expired' });
  }
  const user = DB.users.find(u => u.id === s.userId && u.active);
  if (!user) return res.status(401).json({ error: 'user inactive' });
  req.auth = { ...s, user };
  next();
}
const POLICY = {
  partner_create: ['tenant_admin', 'platform_admin'], partner_approve: ['tenant_admin', 'platform_admin'],
  location_write: ['tenant_admin', 'platform_admin', 'partner_admin'],
  referrer_approve: ['tenant_admin', 'platform_admin'], referrer_submit: ['partner_admin', 'tenant_admin', 'platform_admin'],
  referrer_end: ['partner_admin', 'tenant_admin', 'platform_admin'],
  budget_write: ['tenant_admin'], media_write: ['tenant_admin', 'platform_admin'],
  card_approve: ['tenant_admin', 'platform_admin'], card_request: ['partner_admin', 'referrer', 'tenant_admin', 'platform_admin'],
  content_write: ['tenant_admin'], counter_redeem: ['staff160', 'manager160', 'tenant_admin'],
  void: ['manager160', 'tenant_admin'], payout_verify_company: ['tenant_admin'],
  payout_verify_affil: ['partner_admin', 'tenant_admin'],
  settle: ['tenant_admin', 'partner_admin'], settings: ['tenant_admin', 'platform_admin']
};
function need(key) {
  return (req, res, next) => {
    if (!(POLICY[key] || []).includes(req.auth.role)) return res.status(403).json({ error: 'forbidden for role ' + req.auth.role });
    next();
  };
}
function scopePartners(req) {
  if (req.auth.role === 'partner_admin') return [req.auth.scope];
  if (req.auth.role === 'referrer') { const r = DB.referrers.find(x => x.id === req.auth.scope); return r ? [r.partnerId] : []; }
  return null;
}

/* ---------------- routes ---------------- */
app.get('/api/health', (req, res) => res.json({ ok: true, ts: vnNow() }));

app.post('/api/auth/login', (req, res) => {
  const { email, pass, role, supportReason } = req.body || {};
  const em = String(email || '').trim().toLowerCase();
  if (rateBlocked(em)) return res.status(429).json({ error: 'Rate limited — try in 5 min' });
  const u = DB.users.find(x => x.email === em && x.active);
  if (!u || u.pass !== pass) {
    attempts[em] = { n: ((attempts[em] || {}).n || 0) + 1, t: Date.now() };
    audit(em, 'signin_failed', '', '', 'tenant', true);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  delete attempts[em];
  const r = role || u.roles[0];
  if (!u.roles.includes(r)) return res.status(403).json({ error: 'Role not assigned to this user' });
  let scope = 'tenant';
  if (r === 'partner_admin') scope = u.partnerId || (DB.partners[0] && DB.partners[0].id);
  if (r === 'referrer') scope = u.referrerId || '';
  if (r === 'platform_admin') {
    if (!String(supportReason || '').trim()) return res.status(400).json({ error: 'Support reason required' });
    audit(u.id, 'support_access', '', 'tenant (reason: ' + supportReason + ')', 'tenant', true);
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions().push({ token, userId: u.id, role: r, scope, support: r === 'platform_admin', supportReason: supportReason || '', ts: vnNow() });
  audit(u.id, 'signin', '', r + '/' + scope, 'tenant', true);
  persist();
  const { pass: _p, ...safe } = u;
  res.json({ token, user: safe, role: r, scope });
});

app.post('/api/auth/logout', auth, (req, res) => {
  DB.sessions = sessions().filter(x => x.token !== req.auth.token);
  audit(req.auth.userId, 'signout', '', '', 'tenant', true); persist();
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const { pass: _p, ...safe } = req.auth.user;
  res.json({ user: safe, role: req.auth.role, scope: req.auth.scope });
});

/* full snapshot (frontend boot + sync) */
app.get('/api/db', auth, (req, res) => {
  const sc = scopePartners(req);
  const clone = JSON.parse(JSON.stringify(DB));
  clone.users = clone.users.map(u => { const { pass, ...s } = u; return s; });
  if (sc) {
    clone.partners = clone.partners.filter(p => sc.includes(p.id));
    clone.referrers = clone.referrers.filter(r => sc.includes(r.partnerId));
    clone.locations = clone.locations.filter(l => sc.includes(l.partnerId));
    clone.media = clone.media.filter(m => sc.includes(m.partnerId));
  }
  if (['partner_admin', 'referrer'].includes(req.auth.role)) clone.audits = clone.audits.filter(a => !a.internal);
  res.json(clone);
});

/* generic collection read */
const COLS = ['partners', 'locations', 'referrers', 'budgets', 'media', 'cards', 'services', 'vouchers', 'redemptions', 'payouts', 'settlements', 'audits', 'events', 'invites', 'resets', 'users'];
app.get('/api/:col', auth, (req, res) => {
  if (!COLS.includes(req.params.col)) return res.status(404).json({ error: 'unknown collection' });
  let list = DB[req.params.col] || [];
  if (req.params.col === 'users') list = list.map(u => { const { pass, ...s } = u; return s; });
  res.json(list);
});
app.get('/api/site', (req, res) => res.json(DB.site));
app.get('/api/settings', auth, (req, res) => res.json(DB.settings));

/* ---- domain actions (server-validated) ---- */
app.post('/api/partners', auth, need('partner_create'), (req, res) => {
  const { kind, name, contact, email, phone, ptype } = req.body || {};
  if (!name || !contact || (!email && !phone)) return res.status(400).json({ error: 'name + contact + (email|phone) required' });
  const p = { id: uid('p'), kind: kind === 'individual' ? 'individual' : 'company', name, ptype: kind === 'individual' ? 'independent' : (ptype || 'Hotel'), owner: req.auth.userId, contact, email: email || '', phone: phone || '', status: 'onboarding', validFrom: new Date().toISOString().slice(0, 10), validTo: '', note: '' };
  DB.partners.push(p); audit(req.auth.userId, 'partner_create', '', p.id, 'tenant', true); persist();
  res.json(p);
});
app.post('/api/partners/:id/transition', auth, need('partner_approve'), (req, res) => {
  const p = DB.partners.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const to = req.body.to;
  if (to === 'active' && p.kind === 'company' && ['Hotel', 'Restaurant', 'Spa'].includes(p.ptype || 'Hotel') && !DB.locations.some(l => l.partnerId === p.id))
    return res.status(400).json({ error: 'Require a location before activating location-based partner type' });
  const prev = p.status; p.status = to;
  if (to === 'active') { p.approver = req.auth.userId; p.approvedAt = vnNow(); }
  audit(req.auth.userId, 'partner_' + to, prev, to, p.id, true); persist();
  res.json(p);
});

app.post('/api/locations', auth, need('location_write'), (req, res) => {
  const { partnerId, name, address, ward, referrerId } = req.body || {};
  if (!partnerId || !name || !address || !ward) return res.status(400).json({ error: 'company + name + street + ward required' });
  if (referrerId) {
    const r = DB.referrers.find(x => x.id === referrerId);
    if (!r || r.partnerId !== partnerId) return res.status(400).json({ error: 'Referrer must belong to selected company' });
    if (DB.locations.some(l => l.referrerId === referrerId)) return res.status(400).json({ error: 'Referrer already assigned' });
  }
  const l = { id: uid('l'), partnerId, name, address, ward, referrerId: referrerId || '' };
  DB.locations.push(l); audit(req.auth.userId, 'location_create', '', l.id, partnerId, true); persist();
  res.json(l);
});
app.delete('/api/locations/:id', auth, need('location_write'), (req, res) => {
  DB.locations = DB.locations.filter(x => x.id !== req.params.id);
  audit(req.auth.userId, 'location_delete', req.params.id, '', 'tenant', true); persist();
  res.json({ ok: true });
});

app.post('/api/referrers', auth, need('referrer_submit'), (req, res) => {
  const pid = (req.auth.scope && String(req.auth.scope).startsWith('p_')) ? req.auth.scope : (req.body.partnerId || 'p_saigon');
  const co = DB.partners.find(p => p.id === pid);
  const r = { id: uid('r'), kind: 'affiliated', name: req.body.name, rtype: req.body.rtype || 'Staff', affiliation: 'employed', partnerId: pid, owner: co ? co.owner : req.auth.userId, status: 'pending', phone: '', position: '' };
  if (!r.name) return res.status(400).json({ error: 'name required' });
  DB.referrers.push(r); audit(req.auth.userId, 'referrer_submit', '', r.name, pid, true); persist();
  res.json(r);
});
app.post('/api/referrers/:id/transition', auth, (req, res) => {
  const r = DB.referrers.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const to = req.body.to;
  if (['approved', 'rejected'].includes(to) && !POLICY.referrer_approve.includes(req.auth.role)) return res.status(403).json({ error: 'forbidden' });
  if (to === 'ended' && !POLICY.referrer_end.includes(req.auth.role)) return res.status(403).json({ error: 'forbidden' });
  if (to === 'rejected') {
    if (!req.body.reason) return res.status(400).json({ error: 'Partner-facing reason required' });
    r.rejectReason = req.body.reason; r.rejectNoteInternal = req.body.note || '';
  }
  const prev = r.status;
  if (to === 'approved' && r.kind === 'affiliated') {
    const co = DB.partners.find(p => p.id === r.partnerId); if (co) r.owner = co.owner;
    if (!DB.media.find(m => m.referrerId === r.id && m.kind === 'personal'))
      DB.media.push({ id: uid('m'), kind: 'personal', partnerId: r.partnerId, referrerId: r.id, code: 'SAPAWO-' + r.name.slice(0, 2).toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase(), active: true, revoked: false });
  }
  if (to === 'ended') {
    DB.media.filter(m => m.referrerId === r.id).forEach(m => m.active = false);
    DB.cards.filter(c => c.referrerId === r.id && !['blocked', 'replaced'].includes(c.status)).forEach(c => { c.status = 'blocked'; c.history.push({ s: 'blocked', at: vnNow(), by: req.auth.userId }); });
  }
  r.status = to;
  audit(req.auth.userId, 'referrer_' + to, prev, to, r.partnerId, to !== 'rejected'); persist();
  res.json(r);
});

app.post('/api/budgets', auth, need('budget_write'), (req, res) => {
  const { scopeId, total, discount, indivShare } = req.body || {};
  const tot = +total, d = +discount, s = +indivShare;
  if (!(tot > 0) || d < 5 || d >= tot) return res.status(400).json({ error: 'min 5% discount, 0 < discount < total' });
  const isInd = (DB.partners.find(p => p.id === scopeId) || {}).kind === 'individual';
  let rec;
  if (isInd) {
    if (d + s !== tot) return res.status(400).json({ error: 'Independent: discount + indivComm must = total' });
    rec = { id: uid('b'), scopeId, total: tot, discount: d, indivComm: s, by: req.auth.userId, at: vnNow(), futureOnly: true };
  } else {
    const net = tot - d - s; if (net < 0) return res.status(400).json({ error: 'Discount + share exceeds total' });
    rec = { id: uid('b'), scopeId, total: tot, discount: d, companyComm: tot - d, indivShare: s, companyNet: net, by: req.auth.userId, at: vnNow(), futureOnly: true };
  }
  DB.budgets.push(rec); audit(req.auth.userId, 'budget_version', '', rec.id, scopeId, true); persist();
  res.json(rec);
});

app.post('/api/media', auth, need('media_write'), (req, res) => {
  const { locationId } = req.body || {};
  if (locationId && !DB.locations.find(l => l.id === locationId)) return res.status(400).json({ error: 'real location only' });
  const loc = locationId ? DB.locations.find(l => l.id === locationId) : null;
  const m = { id: uid('m'), kind: loc ? 'location' : 'company', partnerId: loc ? loc.partnerId : (req.body.partnerId || 'p_saigon'), locationId: locationId || undefined, code: 'SAPAWO-' + crypto.randomBytes(3).toString('hex').toUpperCase(), active: true, revoked: false };
  DB.media.push(m); audit(req.auth.userId, 'media_create', '', m.code, m.partnerId, true); persist();
  res.json(m);
});
app.post('/api/media/:id/replace', auth, need('media_write'), (req, res) => {
  const m = DB.media.find(x => x.id === req.params.id); if (!m) return res.status(404).json({ error: 'not found' });
  m.revoked = true; m.active = false;
  const nm = { id: uid('m'), kind: m.kind, partnerId: m.partnerId, referrerId: m.referrerId, locationId: m.locationId, code: m.code + '-R2', active: true, revoked: false };
  DB.media.push(nm); audit(req.auth.userId, 'media_replace', m.code, nm.code, m.partnerId, true); persist();
  res.json(nm);
});
app.post('/api/media/:id/block', auth, need('media_write'), (req, res) => {
  const m = DB.media.find(x => x.id === req.params.id); if (!m) return res.status(404).json({ error: 'not found' });
  m.active = false; audit(req.auth.userId, 'media_block', m.code, 'blocked', m.partnerId, true); persist();
  res.json(m);
});

app.post('/api/cards', auth, (req, res) => {
  if (!POLICY.card_request.includes(req.auth.role)) return res.status(403).json({ error: 'forbidden' });
  const c = { id: uid('c'), partnerId: (req.auth.scope && String(req.auth.scope).startsWith('p_')) ? req.auth.scope : 'p_saigon', referrerId: req.auth.role === 'referrer' ? req.auth.scope : (req.body.referrerId || 'r_an'), status: 'requested', funding: req.body.funding || 'free', requester: req.auth.userId, history: [{ s: 'requested', at: vnNow(), by: req.auth.userId }] };
  DB.cards.push(c); audit(req.auth.userId, 'card_request', '', c.id, c.partnerId, true); persist();
  res.json(c);
});
app.post('/api/cards/:id/transition', auth, need('card_approve'), (req, res) => {
  const c = DB.cards.find(x => x.id === req.params.id); if (!c) return res.status(404).json({ error: 'not found' });
  const order = { requested: ['approved', 'rejected'], approved: ['in_production'], in_production: ['delivered'], delivered: ['blocked', 'replaced'], blocked: ['replaced'] };
  if (!(order[c.status] || []).includes(req.body.to)) return res.status(400).json({ error: 'Illegal transition' });
  const prev = c.status; c.status = req.body.to;
  c.history.push({ s: c.status, at: vnNow(), by: req.auth.userId });
  if (c.status === 'approved') c.approver = req.auth.userId;
  audit(req.auth.userId, 'card_' + c.status, prev, c.status, c.partnerId, true); persist();
  res.json(c);
});

/* anonymous voucher activation (no auth) */
app.post('/api/vouchers/activate', (req, res) => {
  const { code, deviceId } = req.body || {};
  const m = DB.media.find(x => x.code === code);
  if (!m || !m.active || m.revoked) return res.status(400).json({ error: 'Referral blocked' });
  const rq = m.referrerId ? DB.referrers.find(r => r.id === m.referrerId) : null;
  if (rq && rq.status !== 'approved') return res.status(400).json({ error: 'Referrer not approved' });
  const p = m.partnerId ? DB.partners.find(x => x.id === m.partnerId) : null;
  if (p && p.status !== 'active') return res.status(400).json({ error: 'Partner inactive' });
  if (!req.body.force) {
    const prior = DB.vouchers.find(v => v.mediaId === m.id && v.deviceId === deviceId && v.status === 'active' && new Date(v.expiresAt) > new Date());
    if (prior) return res.json({ ...prior, existing: true });
  }
  const snap = latestSnap(m);
  const ref = crypto.randomBytes(3).toString('hex').toUpperCase();
  const at = new Date(), exp = new Date(at.getTime() + 7 * 24 * 3600 * 1000);
  const v = { id: uid('v'), code: 'V-' + ref, ref, mediaId: m.id, attribution: { company: m.partnerId, location: m.locationId || null, affiliated: m.kind === 'personal' ? m.referrerId : null, medium: m.id }, snapshot: snap, status: 'active', activatedAt: at.toISOString(), expiresAt: exp.toISOString(), deviceId, contactPrefill: `Voucher ${ref} · ${snap.discountPct}% · exp ${exp.toISOString()}` };
  DB.vouchers.push(v);
  DB.events.push({ k: 'open', code: m.code, at: vnNow(), dev: deviceId });
  audit('anonymous', 'voucher_activate', '', ref, m.partnerId, false); persist();
  res.json(v);
});
app.post('/api/events/open', (req, res) => {
  const { code, deviceId } = req.body || {};
  if (!DB.events.find(e => e.k === 'open' && e.code === code && e.dev === deviceId)) { DB.events.push({ k: 'open', code, at: vnNow(), dev: deviceId }); persist(); }
  res.json({ ok: true });
});

/* counter */
app.post('/api/counter/validate', auth, (req, res) => {
  const v = DB.vouchers.find(x => x.ref === req.body.code || x.code === req.body.code);
  if (!v) return res.json({ verdict: 'invalid' });
  if (v.status === 'used') return res.json({ verdict: 'used' });
  if (new Date(v.expiresAt) < new Date() || v.status === 'expired') return res.json({ verdict: 'expired' });
  const p = DB.partners.find(x => x.id === v.attribution.company);
  res.json({ verdict: 'valid', partner: p ? p.name : '', discountPct: v.snapshot.discountPct, expiresAt: v.expiresAt });
});
app.post('/api/counter/redeem', auth, (req, res) => {
  if (!POLICY.counter_redeem.includes(req.auth.role)) return res.status(403).json({ error: 'Staff/Manager login required' });
  const v = DB.vouchers.find(x => x.ref === req.body.code || x.code === req.body.code);
  const gross = Math.round(+req.body.gross || 0);
  if (!v || v.status !== 'active') return res.status(400).json({ error: 'Not redeemable (idempotent)' });
  if (gross <= 0) return res.status(400).json({ error: 'gross > 0 required' });
  if (new Date(v.expiresAt) < new Date()) { v.status = 'expired'; persist(); return res.status(400).json({ error: 'Expired' }); }
  if (DB.redemptions.find(r => r.voucherId === v.id && !r.voided)) return res.status(409).json({ error: 'Already redeemed (idempotent)' });
  const c = calc(gross, v.snapshot);
  const r = { id: uid('r'), voucherId: v.id, ...c, staff: req.auth.userId, ts: vnNow(), voided: false };
  DB.redemptions.push(r); v.status = 'used';
  audit(req.auth.userId, 'redeem', v.ref, { gross: c.gross, pay: c.payable }, v.attribution.company, false); persist();
  res.json(r);
});
app.post('/api/redemptions/:id/void', auth, need('void'), (req, res) => {
  const r = DB.redemptions.find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: 'not found' });
  if (r.settlementId) return res.status(400).json({ error: 'In Paid settlement — outside V1' });
  if (!req.body.reason) return res.status(400).json({ error: 'reason required' });
  r.voided = true; r.voidReason = req.body.reason; r.voidBy = req.auth.userId; r.voidAt = vnNow();
  r.reversal = { ts: r.voidAt, by: r.voidBy, reason: req.body.reason };
  const v = DB.vouchers.find(x => x.id === r.voucherId);
  if (v) v.status = new Date(v.expiresAt) < new Date() ? 'expired' : 'active';
  audit(req.auth.userId, 'void', r.id, req.body.reason, 'tenant', true); persist();
  res.json(r);
});

/* payouts + settlements */
app.post('/api/payouts', auth, (req, res) => {
  const { ownerType, ownerId, bank, account, beneficiary, qr } = req.body || {};
  if (!beneficiary || !bank || !account) return res.status(400).json({ error: 'beneficiary + bank + account required' });
  const p = { id: uid('po'), ownerType: ownerType || 'company', ownerId: ownerId || 'p_saigon', bank, account, beneficiary, qr: qr || '', verified: 'pending', by: req.auth.userId, at: vnNow() };
  DB.payouts.push(p); audit(req.auth.userId, 'payout_create', '', account, 'tenant', true); persist();
  res.json(p);
});
app.post('/api/payouts/:id/verify', auth, (req, res) => {
  const p = DB.payouts.find(x => x.id === req.params.id); if (!p) return res.status(404).json({ error: 'not found' });
  if (p.ownerType === 'affiliated') {
    if (!POLICY.payout_verify_affil.includes(req.auth.role)) return res.status(403).json({ error: 'Partner/Tenant admin required' });
  } else if (!POLICY.payout_verify_company.includes(req.auth.role)) return res.status(403).json({ error: 'Tenant admin required' });
  p.verified = 'verified'; p.by = req.auth.userId; p.at = vnNow();
  audit(req.auth.userId, 'payout_verify', 'pending', 'verified', p.ownerId, true); persist();
  res.json(p);
});
app.post('/api/settlements', auth, (req, res) => {
  if (!POLICY.settle.includes(req.auth.role)) return res.status(403).json({ error: 'forbidden' });
  const { itemIds, amount, ref, note, evidence, confirm } = req.body || {};
  if (!Array.isArray(itemIds) || !itemIds.length) return res.status(400).json({ error: 'select items' });
  if (!confirm) return res.status(400).json({ error: 'transfer confirmation required' });
  const items = itemIds.map(id => DB.redemptions.find(r => r.id === id)).filter(Boolean);
  if (items.length !== itemIds.length || items.some(r => r.voided || r.settlementId)) return res.status(400).json({ error: 'items unavailable' });
  const comps = new Set(items.map(r => (DB.vouchers.find(v => v.id === r.voucherId) || {}).attribution.company));
  if (comps.size !== 1) return res.status(400).json({ error: 'one recipient at a time' });
  const comp = [...comps][0];
  const coProf = DB.payouts.find(p => p.ownerId === comp);
  if (coProf && coProf.verified !== 'verified') return res.status(400).json({ error: 'company payout profile unverified' });
  const sum = items.reduce((s, r) => s + r.coComm + r.indComm, 0);
  const s = { id: uid('st'), items: itemIds, amount: Math.round(+amount || sum), date: vnNow(), payer: req.auth.userId, recipientId: comp, ref: ref || '', note: note || '', evidence: evidence === 'with' ? 'with' : 'without' };
  DB.settlements.push(s);
  items.forEach(r => r.settlementId = s.id);
  audit(req.auth.userId, 'settlement_paid', '', s.id + ':' + s.amount, comp, true); persist();
  res.json(s);
});

/* services / site / settings */
app.post('/api/services', auth, need('content_write'), (req, res) => {
  const s = { id: uid('s'), en: req.body.en || 'New', vi: req.body.vi || 'Mới', dur: +req.body.dur || 60, price: +req.body.price || 500000, img: req.body.img || '', hl: false };
  DB.services.push(s); audit(req.auth.userId, 'content_add', '', s.id, 'tenant', true); persist();
  res.json(s);
});
app.post('/api/services/:id/highlight', auth, need('content_write'), (req, res) => {
  const s = DB.services.find(x => x.id === req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
  s.hl = !s.hl; persist(); res.json(s);
});
app.put('/api/site', auth, need('content_write'), (req, res) => {
  Object.assign(DB.site, req.body || {});
  audit(req.auth.userId, 'content_contacts', '', 'saved', 'tenant', true); persist();
  res.json(DB.site);
});
app.put('/api/settings', auth, need('settings'), (req, res) => {
  if (req.body.vat != null) DB.settings.vat = Math.round(+req.body.vat || 8);
  if (req.body.lang) DB.settings.lang = req.body.lang;
  audit(req.auth.userId, 'settings', '', 'vat ' + DB.settings.vat, 'tenant', true); persist();
  res.json(DB.settings);
});
app.post('/api/invites', auth, (req, res) => {
  const inv = { email: req.body.email, by: req.auth.userId, at: vnNow(), token: uid('tok') };
  DB.invites.push(inv); audit(req.auth.userId, 'invite', '', inv.email, 'tenant', true); persist();
  res.json(inv);
});
app.post('/api/resets', auth, (req, res) => {
  const r = { email: req.body.email, at: vnNow(), token: uid('rst'), exp: new Date(Date.now() + 3600e3).toISOString() };
  DB.resets.push(r); audit(req.auth.userId, 'reset', '', r.email, 'tenant', true); persist();
  res.json(r);
});

/* reports */
app.get('/api/reports/funnel', auth, (req, res) => {
  const o = DB.events.filter(e => e.k === 'open').length, a = DB.vouchers.length;
  const reds = DB.redemptions.filter(x => !x.voided);
  res.json({ opens: o, activations: a, redemptions: reds.length, revenue: reds.reduce((s, x) => s + x.gross, 0), commission: reds.reduce((s, x) => s + x.coComm + x.indComm, 0), paid: DB.settlements.reduce((s, x) => s + x.amount, 0) });
});

/* serve frontend */
app.use(express.static(FRONT_DIR));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(FRONT_DIR, 'index.html'));
});

app.listen(PORT, () => console.log(`Connect backend on http://localhost:${PORT} (data: data.json)`));
