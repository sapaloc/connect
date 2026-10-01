import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ROLES } from '#domain';
import { ensureActiveUser, ensureTenant } from '../src/db/bootstrap.js';
import { fromDecimal128, toDecimal128 } from '../src/db/decimal.js';
import { collection } from '../src/db/mongo.js';
import { Agent, PASSWORD, resetDatabase, startServer, tokenFromLink } from './helpers.js';

const NEW_PASSWORD = 'Welcome#2026';
/** Phase 1: fixed guest discount and fixed partner commission, no VAT. */
const HOTEL = {
  name: 'Khách sạn Hoa Sen',
  relationshipKind: 'COMPANY',
  partnerType: 'HOTEL',
  rule: { customerDiscountAmount: '100000', commissionAmount: '150000' },
  account: { email: 'mai@hoasen.local', displayName: 'Chị Mai' },
};
const DRIVER = {
  name: 'Anh Tuấn',
  relationshipKind: 'INDEPENDENT_INDIVIDUAL',
  partnerType: 'DRIVER',
  rule: { customerDiscountAmount: '50000', commissionAmount: '80000' },
  account: { email: 'tuan@driver.local', displayName: 'Anh Tuấn' },
};

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server;
/** @type {Agent} */
let admin;
/** @type {Agent} */
let staff;
/** @type {Agent} */
let manager;
/** @type {Agent} */
let hotelAdmin;
/** @type {Agent} */
let driver;
/** @type {any} */
let hotel;
/** @type {any} */
let driverPartner;

/** A date about a month ahead, as the console sends it. */
function nextMonth() {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** @param {string} email @param {string} [password] */
async function signedIn(email, password = PASSWORD) {
  const agent = new Agent(server.baseUrl);
  assert.equal((await agent.login(email, password)).status, 200, email);
  return agent;
}

/** @param {any} body */
async function partnerWithAccount(body) {
  const res = await admin.post('/api/v1/partners', body);
  assert.equal(res.status, 201);
  const accept = await new Agent(server.baseUrl).post('/api/v1/auth/invitations/accept', {
    token: tokenFromLink(res.body.invitation.inviteUrl),
    password: NEW_PASSWORD,
  });
  assert.equal(accept.status, 200);
  return { partner: res.body.partner, agent: await signedIn(body.account.email, NEW_PASSWORD) };
}

/** @type {Map<string, Agent>} the guest phone that took each voucher */
const phones = new Map();

/** A customer taps the partner QR and gets a voucher code. @param {string} token */
async function activated(token) {
  const phone = new Agent(server.baseUrl);
  await phone.get(`/api/v1/public/referrals/${token}`);
  const res = await phone.post(`/api/v1/public/referrals/${token}/activate`);
  assert.equal(res.status, 201);
  phones.set(res.body.voucher.code, phone);
  return /** @type {string} */ (res.body.voucher.code);
}

/**
 * Counter sends the bill, the guest confirms on the phone that took the voucher.
 * @param {Agent} counter @param {string} code @param {string} grossAmount
 */
async function redeemReferral(counter, code, grossAmount) {
  const sent = await counter.post(`/api/v1/vouchers/${code}/confirmations`, { grossAmount });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const confirmed = await /** @type {Agent} */ (phones.get(code)).post(`/api/v1/public/confirmations/${sent.body.confirmation.id}/confirm`);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  const res = await counter.get(`/api/v1/confirmations/${sent.body.confirmation.id}`);
  assert.equal(res.body.confirmation.status, 'CONFIRMED');
  return { status: res.status, body: { voucher: res.body.confirmation.voucher } };
}

before(async () => {
  await resetDatabase();
  const other = await ensureTenant('Other Shop');
  await ensureActiveUser({ email: 'admin@other.local', displayName: 'Other Admin', password: PASSWORD, role: ROLES.TENANT_ADMIN, tenantId: other });
  server = await startServer();
  admin = await signedIn('admin@number160.local');
  staff = await signedIn('staff@number160.local');
  manager = await signedIn('manager@number160.local');
  ({ partner: hotel, agent: hotelAdmin } = await partnerWithAccount(HOTEL));
  ({ partner: driverPartner, agent: driver } = await partnerWithAccount(DRIVER));
});

after(async () => {
  await server?.close();
});

describe('@money referral redemption', () => {
  /** @type {string} */
  let code;

  it('bill 2,600,000: fixed 100,000 off, fixed 150,000 commission, no VAT; Staff sees no commission', async () => {
    code = await activated(hotel.qr.token);
    const res = await redeemReferral(staff, code, '2600000');
    assert.equal(res.status, 200);
    const shown = res.body.voucher;
    assert.deepEqual(
      { gross: shown.redemption.grossAmount, discount: shown.redemption.discountAmount, payable: shown.redemption.payableAmount },
      { gross: '2600000.0000', discount: '100000.0000', payable: '2500000.0000' },
    );
    assert.doesNotMatch(JSON.stringify(res.body), /commission|150000|partner/i);

    const vouchers = await collection('vouchers');
    const stored = await vouchers.findOne({ code });
    assert.equal(stored?.redemption.vatRate, undefined);
    assert.equal(stored?.redemption.netNetCommissionBase, undefined);

    const items = await (await collection('commissionItems')).find({ voucherId: stored?._id }).toArray();
    assert.equal(items.length, 1);
    assert.deepEqual(
      {
        type: items[0].obligationType,
        rate: fromDecimal128(items[0].rate),
        base: fromDecimal128(items[0].baseAmount),
        amount: fromDecimal128(items[0].amount),
        status: items[0].status,
        partnerId: items[0].partnerId,
        redemptionId: items[0].redemptionId,
      },
      {
        type: 'TENANT_TO_COMPANY',
        rate: '0.0000',
        base: '2500000.0000',
        amount: '150000.0000',
        status: 'OPEN',
        partnerId: hotel.id,
        redemptionId: stored?.redemption.id,
      },
    );
  });

  it('an independent individual gets TENANT_TO_INDEPENDENT_INDIVIDUAL with its own fixed amounts', async () => {
    const driverCode = await activated(driverPartner.qr.token);
    const res = await redeemReferral(staff, driverCode, '1000000');
    assert.equal(res.body.voucher.redemption.payableAmount, '950000.0000');
    const vouchers = await collection('vouchers');
    const stored = await vouchers.findOne({ code: driverCode });
    const [item] = await (await collection('commissionItems')).find({ voucherId: stored?._id }).toArray();
    assert.equal(item.obligationType, 'TENANT_TO_INDEPENDENT_INDIVIDUAL');
    assert.equal(fromDecimal128(item.baseAmount), '950000.0000');
    assert.equal(fromDecimal128(item.amount), '80000.0000');
  });

  it('a percent voucher activated before phase 1 still redeems, commission on what the guest pays (no VAT)', async () => {
    const legacyCode = await activated(hotel.qr.token);
    const vouchers = await collection('vouchers');
    await vouchers.updateOne(
      { code: legacyCode },
      {
        $set: {
          discountType: 'PERCENT',
          discountValue: toDecimal128('0.0700'),
          ruleSnapshot: {
            relationshipKind: 'COMPANY',
            totalBudgetRate: toDecimal128('0.1500'),
            customerDiscountRate: toDecimal128('0.0700'),
            companyCommissionRate: toDecimal128('0.0800'),
            individualShareRate: toDecimal128('0.0000'),
            companyNetCommissionRate: toDecimal128('0.0800'),
            individualCommissionRate: null,
          },
        },
      },
    );
    const res = await redeemReferral(staff, legacyCode, '1100000');
    assert.equal(res.status, 200);
    assert.equal(res.body.voucher.redemption.discountAmount, '77000.0000');
    const stored = await vouchers.findOne({ code: legacyCode });
    const [item] = await (await collection('commissionItems')).find({ voucherId: stored?._id }).toArray();
    // 1,100,000 − 7 % = 1,023,000; × 8 % = 81,840
    assert.equal(fromDecimal128(item.amount), '81840.0000');
  });

  it('percent terms set today: 10% off the bill, 15% of what the guest pays; switching back keeps the voucher terms', async () => {
    const created = await admin.post('/api/v1/partners', {
      name: 'Tài xế Phần Trăm',
      relationshipKind: 'INDEPENDENT_INDIVIDUAL',
      partnerType: 'DRIVER',
      rule: { pricingModel: 'PERCENT', customerDiscountPercent: '10', commissionPercent: '15' },
    });
    assert.equal(created.status, 201);
    const percentCode = await activated(created.body.partner.qr.token);
    const path = `/api/v1/partners/${created.body.partner.id}/rule`;
    assert.equal((await admin.post(path, { pricingModel: 'FIXED_AMOUNT', ...DRIVER.rule })).status, 200);

    const res = await redeemReferral(staff, percentCode, '1000000');
    assert.equal(res.status, 200);
    assert.equal(res.body.voucher.redemption.discountAmount, '100000.0000');
    assert.equal(res.body.voucher.redemption.payableAmount, '900000.0000');
    const stored = await (await collection('vouchers')).findOne({ code: percentCode });
    const [item] = await (await collection('commissionItems')).find({ voucherId: stored?._id }).toArray();
    assert.equal(item.obligationType, 'TENANT_TO_INDEPENDENT_INDIVIDUAL');
    // 1,000,000 − 10 % = 900,000; × 15 % = 135,000
    assert.equal(fromDecimal128(item.amount), '135000.0000');
  });

  it('no direct redeem for a partner voucher; the guest confirming twice at once: one success, one set of items', async () => {
    const racing = await activated(hotel.qr.token);
    const direct = await staff.post(`/api/v1/vouchers/${racing}/redeem`, { grossAmount: '500000' });
    assert.equal(direct.status, 409);
    assert.equal(direct.body.error.code, 'GUEST_CONFIRMATION_REQUIRED');
    const sent = await staff.post(`/api/v1/vouchers/${racing}/confirmations`, { grossAmount: '500000' });
    const phone = /** @type {Agent} */ (phones.get(racing));
    const path = `/api/v1/public/confirmations/${sent.body.confirmation.id}/confirm`;
    const results = await Promise.all([phone.post(path), phone.post(path)]);
    assert.deepEqual(results.map((res) => res.status).sort(), [200, 409]);
    const vouchers = await collection('vouchers');
    const stored = await vouchers.findOne({ code: racing });
    assert.equal(await (await collection('commissionItems')).countDocuments({ voucherId: stored?._id }), 1);
  });

  it('Manager voids the redemption: commission VOID, voucher usable again, redeem again makes new items', async () => {
    assert.equal((await staff.post(`/api/v1/vouchers/${code}/void-redemption`, { reason: 'wrong bill' })).status, 403);
    assert.equal((await manager.post(`/api/v1/vouchers/${code}/void-redemption`, {})).status, 422);
    const res = await manager.post(`/api/v1/vouchers/${code}/void-redemption`, { reason: 'Typed 2,600,000 instead of 260,000' });
    assert.equal(res.status, 200);
    assert.equal(res.body.voucher.status, 'ACTIVE');
    assert.equal(res.body.voucher.redemption, null);

    const items = await collection('commissionItems');
    const vouchers = await collection('vouchers');
    const stored = await vouchers.findOne({ code });
    assert.equal(await items.countDocuments({ voucherId: stored?._id, status: 'VOID' }), 1);
    assert.equal(stored?.voidedRedemptions.length, 1);
    assert.equal((await manager.post(`/api/v1/vouchers/${code}/void-redemption`, { reason: 'again' })).status, 409);

    assert.equal((await redeemReferral(staff, code, '260000')).status, 200);
    const open = await items.find({ voucherId: stored?._id, status: 'OPEN' }).toArray();
    assert.equal(open.length, 1);
    assert.equal(fromDecimal128(open[0].amount), '150000.0000');
    const audit = await collection('auditEvents');
    assert.equal(await audit.countDocuments({ eventType: 'REDEMPTION_VOIDED' }), 1);
  });

  it('a direct voucher can be voided back too, without commission', async () => {
    const issued = await manager.post('/api/v1/vouchers', { discountType: 'PERCENT', discountValue: '10', validUntil: nextMonth() });
    const direct = issued.body.vouchers[0].code;
    assert.equal((await staff.post(`/api/v1/vouchers/${direct}/redeem`, { grossAmount: '100000' })).status, 200);
    const res = await manager.post(`/api/v1/vouchers/${direct}/void-redemption`, { reason: 'test' });
    assert.equal(res.status, 200);
    assert.equal(res.body.voucher.status, 'ACTIVE');
  });
});

describe('@money @permission commission reports', () => {
  it('Merchant admin sees counts and commission owed per partner; Manager sees counts only', async () => {
    const list = await admin.get('/api/v1/partners');
    const row = list.body.partners.find((/** @type {any} */ p) => p.id === hotel.id);
    assert.equal(list.body.withCommission, true);
    // Open: 150,000 (re-redeemed voucher) + 150,000 (racing voucher) + 81,840 (percent voucher)
    assert.deepEqual(row.stats, { opens: 3, activations: 3, redemptions: 3, commissionOpen: '381840.0000', commissionPaid: '0.0000', commissionPending: '0.0000', pendingReviews: 0, lastPaidAt: null });

    const managerList = await manager.get('/api/v1/partners');
    const managerRow = managerList.body.partners.find((/** @type {any} */ p) => p.id === hotel.id);
    assert.equal(managerList.body.withCommission, false);
    assert.equal('commissionOpen' in managerRow.stats, false);
  });

  it('the partner sees only its own QR, counts and commission on /my', async () => {
    const res = await hotelAdmin.get('/api/v1/my/partner');
    assert.equal(res.status, 200);
    assert.equal(res.body.partner.name, HOTEL.name);
    assert.equal(res.body.partner.merchantName, 'Number160');
    assert.equal(res.body.qr.token, hotel.qr.token);
    assert.deepEqual(res.body.rule, {
      pricingModel: 'FIXED_AMOUNT',
      customerDiscountAmount: '100000.0000',
      commissionAmount: '150000.0000',
      customerDiscountRate: '0.0000',
      commissionRate: null,
    });
    assert.equal(res.body.stats.commissionOpen, '381840.0000');
    assert.deepEqual(res.body.recent.map((/** @type {any} */ item) => item.status).sort(), ['OPEN', 'OPEN', 'OPEN', 'VOID']);
    assert.deepEqual(res.body.payouts, []);
    assert.doesNotMatch(JSON.stringify(res.body), /redeemedBy|customerName|payable|code/);

    const own = await driver.get('/api/v1/my/partner');
    assert.equal(own.body.partner.name, DRIVER.name);
    assert.equal(own.body.stats.commissionOpen, '80000.0000');
    assert.equal(own.body.recent.length, 1);
  });

  it('staff and merchant roles cannot open /my; partners cannot list partners', async () => {
    assert.equal((await staff.get('/api/v1/my/partner')).status, 403);
    assert.equal((await admin.get('/api/v1/my/partner')).status, 403);
    assert.equal((await hotelAdmin.get('/api/v1/partners')).status, 403);
  });
});

describe('@money @permission mark commission as paid', () => {
  it('only the Merchant admin of this merchant can record a payout', async () => {
    assert.equal((await manager.post(`/api/v1/partners/${hotel.id}/payouts`, {})).status, 403);
    assert.equal((await staff.post(`/api/v1/partners/${hotel.id}/payouts`, {})).status, 403);
    assert.equal((await hotelAdmin.post(`/api/v1/partners/${hotel.id}/payouts`, {})).status, 403);
    const other = await signedIn('admin@other.local');
    assert.equal((await other.post(`/api/v1/partners/${hotel.id}/payouts`, {})).status, 404);
  });

  it('pays every unpaid item at once; the partner sees paid and unpaid; nothing left to pay afterwards', async () => {
    const res = await admin.post(`/api/v1/partners/${hotel.id}/payouts`, { note: 'Bank transfer 30/09' });
    assert.equal(res.status, 201);
    assert.equal(res.body.payout.amount, '381840.0000');
    assert.equal(res.body.payout.itemCount, 3);

    const items = await collection('commissionItems');
    const paid = await items.find({ partnerId: hotel.id, status: 'PAID' }).toArray();
    assert.equal(paid.length, 3);
    assert.ok(paid.every((item) => item.payoutId === res.body.payout.id && item.paidAt instanceof Date));

    const row = (await admin.get('/api/v1/partners')).body.partners.find((/** @type {any} */ p) => p.id === hotel.id);
    assert.equal(row.stats.commissionOpen, '0.0000');
    assert.equal(row.stats.commissionPaid, '381840.0000');
    assert.equal(row.stats.lastPaidAt, res.body.payout.paidAt);

    const mine = await hotelAdmin.get('/api/v1/my/partner');
    assert.deepEqual(mine.body.payouts.map((/** @type {any} */ p) => p.amount), ['381840.0000']);
    assert.deepEqual(mine.body.recent.map((/** @type {any} */ item) => item.status).sort(), ['PAID', 'PAID', 'PAID', 'VOID']);

    const again = await admin.post(`/api/v1/partners/${hotel.id}/payouts`, {});
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'NOTHING_TO_PAY');
    const audit = await collection('auditEvents');
    assert.equal(await audit.countDocuments({ eventType: 'COMMISSION_PAID', entityId: hotel.id }), 1);
  });

  it('a redemption whose commission is paid can no longer be voided', async () => {
    const vouchers = await collection('vouchers');
    const item = await (await collection('commissionItems')).findOne({ partnerId: hotel.id, status: 'PAID' });
    const voucher = await vouchers.findOne({ _id: item?.voucherId });
    const res = await manager.post(`/api/v1/vouchers/${voucher?.code}/void-redemption`, { reason: 'late' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'COMMISSION_PAID');
  });
});
