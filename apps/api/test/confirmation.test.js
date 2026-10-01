import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ROLES } from '#domain';
import sharp from 'sharp';
import { ensureActiveUser, ensureTenant } from '../src/db/bootstrap.js';
import { fromDecimal128 } from '../src/db/decimal.js';
import { collection } from '../src/db/mongo.js';
import { Agent, PASSWORD, resetDatabase, startServer } from './helpers.js';

/** Guest confirms the bill from the browser that took the partner voucher (plan §0.9). */
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
/** @type {Agent} */
let manager;
/** @type {Agent} */
let staff;
/** @type {any} */
let hotel;

/** @param {string} email */
async function signedIn(email) {
  const agent = new Agent(server.baseUrl);
  assert.equal((await agent.login(email)).status, 200, email);
  return agent;
}

/** A guest phone takes a voucher from the partner QR. */
async function guestWithVoucher() {
  const phone = new Agent(server.baseUrl);
  await phone.get(`/api/v1/public/referrals/${hotel.qr.token}`);
  const res = await phone.post(`/api/v1/public/referrals/${hotel.qr.token}/activate`);
  assert.equal(res.status, 201);
  return { phone, code: /** @type {string} */ (res.body.voucher.code) };
}

/** @param {string} code @param {string} grossAmount */
async function send(code, grossAmount) {
  const res = await staff.post(`/api/v1/vouchers/${code}/confirmations`, { grossAmount });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.confirmation;
}

/** @param {Agent} agent @param {string} code */
async function upload(agent, code) {
  const body = await sharp({ create: { width: 600, height: 900, channels: 3, background: '#F4F1EA' } }).jpeg().toBuffer();
  const res = await fetch(`${agent.baseUrl}/api/v1/vouchers/${code}/bill-photos`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', cookie: agent.cookie, 'x-forwarded-for': agent.ip },
    body,
  });
  assert.equal(res.status, 201);
}

/** @param {string} code */
async function storedVoucher(code) {
  return (await collection('vouchers')).findOne({ code });
}

/** @param {string} code */
async function itemsOf(code) {
  const voucher = await storedVoucher(code);
  return (await collection('commissionItems')).find({ voucherId: voucher?._id }).toArray();
}

before(async () => {
  await resetDatabase();
  const other = await ensureTenant('Other Shop');
  await ensureActiveUser({ email: 'staff@other.local', displayName: 'Other Staff', password: PASSWORD, role: ROLES.STAFF, tenantId: other });
  server = await startServer();
  admin = await signedIn('admin@number160.local');
  manager = await signedIn('manager@number160.local');
  staff = await signedIn('staff@number160.local');
  const res = await admin.post('/api/v1/partners', HOTEL);
  assert.equal(res.status, 201);
  hotel = res.body.partner;
});

after(async () => {
  await server?.close();
});

describe('@money guest confirms the bill', () => {
  it('CNF-01 a partner voucher is not redeemed straight from the counter; a direct voucher still is', async () => {
    const { code } = await guestWithVoucher();
    const res = await staff.post(`/api/v1/vouchers/${code}/redeem`, { grossAmount: '500000' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'GUEST_CONFIRMATION_REQUIRED');

    const validUntil = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const issued = await manager.post('/api/v1/vouchers', { discountType: 'PERCENT', discountValue: '10', validUntil });
    const direct = issued.body.vouchers[0].code;
    assert.equal((await staff.post(`/api/v1/vouchers/${direct}/confirmations`, { grossAmount: '100000' })).status, 409);
    assert.equal((await staff.post(`/api/v1/vouchers/${direct}/redeem`, { grossAmount: '100000' })).status, 200);
  });

  it('CNF-02 the guest confirms on the phone that took the voucher: redemption and commission use the locked amounts', async () => {
    const { phone, code } = await guestWithVoucher();
    const sent = await send(code, '2600000');
    assert.deepEqual(
      { gross: sent.grossAmount, discount: sent.discountAmount, payable: sent.payableAmount, status: sent.status, path: sent.confirmPath },
      { gross: '2600000.0000', discount: '100000.0000', payable: '2500000.0000', status: 'PENDING', path: `/v/${code}?confirm=${sent.id}` },
    );
    assert.doesNotMatch(JSON.stringify(sent), /commission|150000/);

    const polled = await phone.get(`/api/v1/public/vouchers/${code}/confirmation`);
    assert.equal(polled.body.owner, true);
    assert.equal(polled.body.confirmation.payableAmount, '2500000.0000');

    const res = await phone.post(`/api/v1/public/confirmations/${sent.id}/confirm`);
    assert.equal(res.status, 200);
    assert.equal(res.body.voucher.status, 'REDEEMED');

    const read = await staff.get(`/api/v1/confirmations/${sent.id}`);
    assert.equal(read.body.confirmation.status, 'CONFIRMED');
    assert.equal(read.body.confirmation.voucher.redemption.confirmation, 'GUEST');
    const stored = await storedVoucher(code);
    assert.equal(stored?.redemption.redeemedBy, (await (await collection('users')).findOne({ email: 'staff@number160.local' }))?._id);
    const items = await itemsOf(code);
    assert.equal(items.length, 1);
    assert.equal(fromDecimal128(items[0].amount), '150000.0000');
    assert.equal(items[0].status, 'OPEN');
  });

  it('CNF-03 no cookie, another cookie or a browser signed in to the merchant cannot see or answer', async () => {
    const { phone, code } = await guestWithVoucher();
    const sent = await send(code, '400000');
    const path = `/api/v1/public/confirmations/${sent.id}/confirm`;

    const stranger = new Agent(server.baseUrl);
    assert.equal((await stranger.get(`/api/v1/public/vouchers/${code}/confirmation`)).body.owner, false);
    const none = await stranger.post(path);
    assert.equal(none.status, 403);
    assert.equal(none.body.error.code, 'CONFIRMATION_WRONG_BROWSER');

    const { phone: otherPhone } = await guestWithVoucher();
    assert.equal((await otherPhone.post(path)).status, 403);

    const counterPhone = await signedIn('staff@number160.local');
    counterPhone.cookie = `${counterPhone.cookie}; ${phone.cookie}`;
    assert.equal((await counterPhone.get(`/api/v1/public/vouchers/${code}/confirmation`)).body.owner, false);
    const merchant = await counterPhone.post(path);
    assert.equal(merchant.status, 403);
    assert.equal(merchant.body.error.code, 'CONFIRMATION_MERCHANT_BROWSER');
    assert.equal((await storedVoucher(code))?.status, 'ACTIVE');
  });

  it('CNF-04 expired or declined: nothing recorded, the voucher stays usable', async () => {
    const { phone, code } = await guestWithVoucher();
    const late = await send(code, '300000');
    await (await collection('redemptionConfirmations')).updateOne({ _id: late.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await staff.get(`/api/v1/confirmations/${late.id}`)).body.confirmation.status, 'EXPIRED');
    assert.equal((await phone.get(`/api/v1/public/vouchers/${code}/confirmation`)).body.confirmation, null);
    const tooLate = await phone.post(`/api/v1/public/confirmations/${late.id}/confirm`);
    assert.equal(tooLate.status, 409);
    assert.equal(tooLate.body.error.code, 'CONFIRMATION_NOT_PENDING');

    const wrong = await send(code, '3000000');
    const declined = await phone.post(`/api/v1/public/confirmations/${wrong.id}/decline`);
    assert.equal(declined.status, 200);
    assert.equal((await staff.get(`/api/v1/confirmations/${wrong.id}`)).body.confirmation.status, 'DECLINED');
    assert.equal((await staff.post(`/api/v1/confirmations/${wrong.id}/fallback`, { reason: 'OTHER' })).status, 409);
    assert.equal((await storedVoucher(code))?.status, 'ACTIVE');
    assert.equal((await itemsOf(code)).length, 0);

    const fixed = await send(code, '300000');
    const replaced = await send(code, '320000');
    assert.equal((await staff.get(`/api/v1/confirmations/${fixed.id}`)).body.confirmation.status, 'CANCELLED');
    assert.equal((await phone.post(`/api/v1/public/confirmations/${fixed.id}/confirm`)).status, 409);
    const cancelled = await staff.post(`/api/v1/confirmations/${replaced.id}/cancel`);
    assert.equal(cancelled.body.confirmation.status, 'CANCELLED');
    assert.equal((await storedVoucher(code))?.status, 'ACTIVE');
  });

  it('CNF-05 two taps at once: one success, one set of commission items', async () => {
    const { phone, code } = await guestWithVoucher();
    const sent = await send(code, '500000');
    const path = `/api/v1/public/confirmations/${sent.id}/confirm`;
    const results = await Promise.all([phone.post(path), phone.post(path)]);
    assert.deepEqual(results.map((res) => res.status).sort(), [200, 409]);
    assert.equal((await itemsOf(code)).length, 1);
  });
});

describe('@money @permission guest cannot confirm: recorded with a bill photo, commission reviewed', () => {
  /** @type {string} */
  let approvedCode;
  /** @type {string} */
  let rejectedCode;

  it('CNF-06 needs a reason and a staff bill photo; then the guest gets the discount and the commission waits', async () => {
    const { code } = await guestWithVoucher();
    approvedCode = code;
    const sent = await send(code, '1000000');
    assert.equal((await staff.post(`/api/v1/confirmations/${sent.id}/fallback`, {})).status, 422);
    assert.equal((await staff.post(`/api/v1/confirmations/${sent.id}/fallback`, { reason: 'BECAUSE' })).status, 422);
    const noPhoto = await staff.post(`/api/v1/confirmations/${sent.id}/fallback`, { reason: 'NEW_PHONE' });
    assert.equal(noPhoto.status, 422);
    assert.equal(noPhoto.body.error.code, 'BILL_PHOTO_REQUIRED');

    await upload(staff, code);
    const res = await staff.post(`/api/v1/confirmations/${sent.id}/fallback`, { reason: 'NEW_PHONE' });
    assert.equal(res.status, 200);
    assert.equal(res.body.confirmation.status, 'FALLBACK');
    assert.equal(res.body.confirmation.voucher.status, 'REDEEMED');
    assert.equal(res.body.confirmation.voucher.redemption.payableAmount, '900000.0000');
    assert.equal(res.body.confirmation.voucher.redemption.confirmation, 'UNCONFIRMED');
    assert.equal((await itemsOf(code)).length, 0);

    const review = await (await collection('commissionReviews')).findOne({ voucherId: (await storedVoucher(code))?._id });
    assert.equal(review?.status, 'PENDING');
    assert.equal(fromDecimal128(review?.amount), '150000.0000');

    const row = (await admin.get('/api/v1/partners')).body.partners.find((/** @type {any} */ p) => p.id === hotel.id);
    assert.equal(row.stats.commissionPending, '150000.0000');
    assert.equal(row.stats.pendingReviews, 1);
  });

  it('CNF-07 only the Merchant admin decides; approve makes an OPEN item, reject makes none', async () => {
    const { code } = await guestWithVoucher();
    rejectedCode = code;
    const sent = await send(code, '800000');
    await upload(staff, code);
    assert.equal((await staff.post(`/api/v1/confirmations/${sent.id}/fallback`, { reason: 'PASSED_ON' })).status, 200);

    assert.equal((await staff.get('/api/v1/commission-reviews')).status, 403);
    assert.equal((await manager.get('/api/v1/commission-reviews')).status, 403);
    const list = await admin.get(`/api/v1/commission-reviews?partnerId=${hotel.id}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.reviews.length, 2);
    const byCode = new Map(list.body.reviews.map((/** @type {any} */ r) => [r.voucher.code, r]));
    const approve = /** @type {any} */ (byCode.get(approvedCode));
    const reject = /** @type {any} */ (byCode.get(rejectedCode));
    assert.equal(approve.voucher.billPhotos.length, 1);

    assert.equal((await manager.post(`/api/v1/commission-reviews/${approve.id}/approve`)).status, 403);
    const approved = await admin.post(`/api/v1/commission-reviews/${approve.id}/approve`);
    assert.equal(approved.status, 200);
    assert.equal(approved.body.review.status, 'APPROVED');
    const items = await itemsOf(approvedCode);
    assert.equal(items.length, 1);
    assert.equal(items[0].status, 'OPEN');
    assert.equal(fromDecimal128(items[0].amount), '150000.0000');
    assert.equal((await admin.post(`/api/v1/commission-reviews/${approve.id}/approve`)).status, 409);

    assert.equal((await admin.post(`/api/v1/commission-reviews/${reject.id}/reject`)).status, 422);
    const rejected = await admin.post(`/api/v1/commission-reviews/${reject.id}/reject`, { note: 'Bill does not match' });
    assert.equal(rejected.body.review.status, 'REJECTED');
    assert.equal((await itemsOf(rejectedCode)).length, 0);
    assert.equal((await storedVoucher(rejectedCode))?.status, 'REDEEMED');
  });

  it('voiding a redemption still waiting for review cancels the review', async () => {
    const { code } = await guestWithVoucher();
    const sent = await send(code, '700000');
    await upload(staff, code);
    await staff.post(`/api/v1/confirmations/${sent.id}/fallback`, { reason: 'NO_RESPONSE' });
    assert.equal((await manager.post(`/api/v1/vouchers/${code}/void-redemption`, { reason: 'test' })).status, 200);
    const review = await (await collection('commissionReviews')).findOne({ voucherId: (await storedVoucher(code))?._id });
    assert.equal(review?.status, 'CANCELLED');
  });
});

describe('@permission who can use a partner voucher', () => {
  it('CNF-08 a browser signed in to the merchant cannot take a voucher from the partner QR', async () => {
    const counter = await signedIn('staff@number160.local');
    const res = await counter.post(`/api/v1/public/referrals/${hotel.qr.token}/activate`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'REFERRAL_MERCHANT_BROWSER');
  });

  it('CNF-09 staff of another merchant cannot read or answer a request', async () => {
    const { code } = await guestWithVoucher();
    const sent = await send(code, '200000');
    const other = await signedIn('staff@other.local');
    assert.equal((await other.get(`/api/v1/confirmations/${sent.id}`)).status, 404);
    assert.equal((await other.post(`/api/v1/confirmations/${sent.id}/cancel`)).status, 404);
    assert.equal((await other.post(`/api/v1/vouchers/${code}/confirmations`, { grossAmount: '1' })).status, 404);
    assert.equal((await staff.get('/api/v1/confirmations/not-a-uuid')).status, 404);
  });
});
