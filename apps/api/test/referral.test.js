import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ROLES } from '#domain';
import { ensureActiveUser, ensureTenant } from '../src/db/bootstrap.js';
import { collection, getDb } from '../src/db/mongo.js';
import { setup } from '../src/db/setup.js';
import { Agent, PASSWORD, resetDatabase, startServer } from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOTEL = {
  name: 'Khách sạn Hoa Sen',
  relationshipKind: 'COMPANY',
  partnerType: 'HOTEL',
  rule: { customerDiscountAmount: '100000', commissionAmount: '150000' },
};

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server;
/** @type {Agent} */
let admin;
/** @type {any} */
let hotel;

before(async () => {
  await resetDatabase();
  const other = await ensureTenant('Other Shop');
  await ensureActiveUser({ email: 'admin@other.local', displayName: 'Other Admin', password: PASSWORD, role: ROLES.TENANT_ADMIN, tenantId: other });
  server = await startServer();
  admin = await signedIn('admin@number160.local');
  const res = await admin.post('/api/v1/partners', HOTEL);
  assert.equal(res.status, 201);
  hotel = res.body.partner;
});

after(async () => {
  await server?.close();
});

/** @param {string} email */
async function signedIn(email) {
  const agent = new Agent(server.baseUrl);
  assert.equal((await agent.login(email)).status, 200, email);
  return agent;
}

/** A customer's phone: no account, only the anonymous browser cookie. */
function customer() {
  return new Agent(server.baseUrl);
}

/** @param {string} token */
const open = (/** @type {Agent} */ agent, token) => agent.get(`/api/v1/public/referrals/${token}`);
/** @param {string} token */
const activate = (/** @type {Agent} */ agent, token) => agent.post(`/api/v1/public/referrals/${token}/activate`);

describe('partner QR', () => {
  it('every new partner gets a QR with an unguessable token', () => {
    assert.match(hotel.qr.token, /^[A-Za-z0-9_-]{22}$/);
  });

  it('opening the link shows merchant, partner and discount, and counts a visit', async () => {
    const phone = customer();
    const res = await open(phone, hotel.qr.token);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.referral, {
      merchantName: 'Number160',
      brand: null,
      partnerName: HOTEL.name,
      partnerType: 'HOTEL',
      discountRate: null,
      discountAmount: '100000.0000',
      validityDays: 7,
    });
    assert.equal(res.body.voucher, null);
    assert.match(res.setCookie ?? '', /^mc_bc=[0-9a-f-]{36};.*HttpOnly/);
    const visits = await collection('referralVisits');
    assert.equal(await visits.countDocuments({ partnerId: hotel.id, result: 'VALID' }), 1);
  });

  it('unknown or malformed tokens are 404 and still counted', async () => {
    const phone = customer();
    assert.equal((await open(phone, 'AAAAAAAAAAAAAAAAAAAAAA')).status, 404);
    const res = await open(phone, 'not-a-token');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'REFERRAL_NOT_FOUND');
    const visits = await collection('referralVisits');
    assert.equal(await visits.countDocuments({ result: 'NOT_FOUND' }), 2);
  });
});

describe('anonymous activation', () => {
  /** @type {Agent} */
  let phone;
  /** @type {string} */
  let code;

  it('creates a 7-day REFERRAL voucher with the partner discount and a rule snapshot', async () => {
    phone = customer();
    await open(phone, hotel.qr.token);
    const before = Date.now();
    const res = await activate(phone, hotel.qr.token);
    assert.equal(res.status, 201);
    assert.equal(res.body.created, true);
    const { voucher } = res.body;
    code = voucher.code;
    assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.equal(voucher.status, 'ACTIVE');
    assert.equal(voucher.discountType, 'AMOUNT');
    assert.equal(voucher.discountValue, '100000.0000');
    assert.equal(voucher.merchantName, 'Number160');
    const validFor = new Date(voucher.validUntil).getTime() - before;
    assert.ok(validFor >= 7 * DAY_MS - 5000 && validFor <= 7 * DAY_MS + 5000, `valid for ${validFor} ms`);
    assert.equal('customerName' in voucher, false);

    const vouchers = await collection('vouchers');
    const stored = await vouchers.findOne({ code });
    assert.equal(stored?.source, 'REFERRAL');
    assert.equal(stored?.partnerId, hotel.id);
    assert.equal(stored?.ruleSnapshot.version, 1);
    assert.equal(stored?.ruleSnapshot.pricingModel, 'FIXED_AMOUNT');
    assert.equal(stored?.ruleSnapshot.commissionAmount.toString(), '150000.0000');
    assert.ok(stored?.referralVisitId);
    assert.ok(stored?.browserContextId);
  });

  it('the same browser gets the same voucher back instead of a new one', async () => {
    const again = await activate(phone, hotel.qr.token);
    assert.equal(again.status, 200);
    assert.equal(again.body.created, false);
    assert.equal(again.body.voucher.code, code);
    const reopened = await open(phone, hotel.qr.token);
    assert.equal(reopened.body.voucher.code, code);
  });

  it('five taps at once from one browser still make one voucher', async () => {
    const eager = customer();
    await open(eager, hotel.qr.token);
    const results = await Promise.all(Array.from({ length: 5 }, () => activate(eager, hotel.qr.token)));
    assert.ok(results.every((res) => res.status === 200 || res.status === 201), results.map((res) => res.status).join());
    assert.equal(new Set(results.map((res) => res.body.voucher.code)).size, 1);
    assert.equal(results.filter((res) => res.body.created).length, 1);
  });

  it('another browser gets its own voucher', async () => {
    const res = await activate(customer(), hotel.qr.token);
    assert.equal(res.status, 201);
    assert.notEqual(res.body.voucher.code, code);
  });

  it('the counter looks the voucher up, sends the bill and the guest confirms on the same phone', async () => {
    const staff = await signedIn('staff@number160.local');
    const found = await staff.get(`/api/v1/vouchers/${code}`);
    assert.equal(found.status, 200);
    assert.equal(found.body.voucher.source, 'REFERRAL');
    const sent = await staff.post(`/api/v1/vouchers/${code}/confirmations`, { grossAmount: '2600000' });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.confirmation.payableAmount, '2500000.0000');
    const res = await phone.post(`/api/v1/public/confirmations/${sent.body.confirmation.id}/confirm`);
    assert.equal(res.status, 200);
    assert.equal(res.body.voucher.status, 'REDEEMED');
  });

  it('a new rule version applies to new activations only', async () => {
    assert.equal((await admin.post(`/api/v1/partners/${hotel.id}/rule`, { customerDiscountAmount: '120000', commissionAmount: '150000' })).status, 200);
    const res = await activate(customer(), hotel.qr.token);
    assert.equal(res.body.voucher.discountValue, '120000.0000');
    const vouchers = await collection('vouchers');
    assert.equal((await vouchers.findOne({ code }))?.ruleSnapshot.version, 1);
    assert.equal((await vouchers.findOne({ code: res.body.voucher.code }))?.ruleSnapshot.version, 2);
  });
});

describe('@permission QR lifecycle', () => {
  it('replacing the QR stops the old link at once; vouchers already activated stay valid', async () => {
    const phone = customer();
    const { body } = await activate(phone, hotel.qr.token);
    const oldToken = hotel.qr.token;

    const res = await admin.post(`/api/v1/partners/${hotel.id}/qr/replace`, { reason: 'Printed card lost' });
    assert.equal(res.status, 200);
    assert.notEqual(res.body.partner.qr.token, oldToken);
    hotel = res.body.partner;

    const stale = await open(customer(), oldToken);
    assert.equal(stale.status, 410);
    assert.equal(stale.body.error.code, 'REFERRAL_INACTIVE');
    assert.equal((await activate(customer(), oldToken)).status, 410);
    assert.equal((await open(customer(), hotel.qr.token)).status, 200);

    const voucher = await customer().get(`/api/v1/public/vouchers/${body.voucher.code}`);
    assert.equal(voucher.body.voucher.status, 'ACTIVE');
    const audit = await collection('auditEvents');
    assert.equal(await audit.countDocuments({ eventType: 'REFERRAL_QR_REPLACED' }), 1);
  });

  it('only the Merchant admin of that merchant can replace a QR', async () => {
    const manager = await signedIn('manager@number160.local');
    assert.equal((await manager.post(`/api/v1/partners/${hotel.id}/qr/replace`, {})).status, 403);
    const outsider = await signedIn('admin@other.local');
    assert.equal((await outsider.post(`/api/v1/partners/${hotel.id}/qr/replace`, {})).status, 404);
  });

  it('a paused partner link does not work until resumed; an ended partner has no QR', async () => {
    assert.equal((await admin.post(`/api/v1/partners/${hotel.id}/status`, { status: 'PAUSED' })).status, 200);
    assert.equal((await open(customer(), hotel.qr.token)).status, 410);
    assert.equal((await activate(customer(), hotel.qr.token)).status, 410);
    assert.equal((await admin.post(`/api/v1/partners/${hotel.id}/status`, { status: 'ACTIVE' })).status, 200);
    assert.equal((await open(customer(), hotel.qr.token)).status, 200);

    const ended = await admin.post(`/api/v1/partners/${hotel.id}/status`, { status: 'ENDED', reason: 'Contract over' });
    assert.equal(ended.body.partner.qr, null);
    assert.equal((await open(customer(), hotel.qr.token)).status, 410);
    assert.equal((await admin.post(`/api/v1/partners/${hotel.id}/qr/replace`, {})).status, 409);
  });

  it('db:setup gives a QR to partners created before QR existed', async () => {
    const res = await admin.post('/api/v1/partners', { ...HOTEL, name: 'Nhà hàng Biển Xanh', partnerType: 'RESTAURANT' });
    const media = await collection('referralMedia');
    await media.deleteMany({ partnerId: res.body.partner.id });
    await setup(await getDb());
    assert.equal(await media.countDocuments({ partnerId: res.body.partner.id, status: 'ACTIVE' }), 1);
    await setup(await getDb());
    assert.equal(await media.countDocuments({ partnerId: res.body.partner.id }), 1);
  });
});
