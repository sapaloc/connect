import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { ROLES, sumAmounts, VOUCHER_CODE_PATTERN } from '#domain';
import { ensureActiveUser, ensureTenant } from '../src/db/bootstrap.js';
import { fromDecimal128, toDecimal128 } from '../src/db/decimal.js';
import { collection } from '../src/db/mongo.js';
import { vnDayStart, vnMonthStart } from '../src/partners/history.js';
import { Agent, PASSWORD, resetDatabase, startServer, tokenFromLink } from './helpers.js';

const NEW_PASSWORD = 'Welcome#2026';
const HOTEL = {
  name: 'Khách sạn Lịch Sử',
  relationshipKind: 'COMPANY',
  partnerType: 'HOTEL',
  rule: { customerDiscountAmount: '100000', commissionAmount: '150000' },
  account: { email: 'lan@lichsu.local', displayName: 'Chị Lan' },
};
const DRIVER = {
  name: 'Anh Bình',
  relationshipKind: 'INDEPENDENT_INDIVIDUAL',
  partnerType: 'DRIVER',
  rule: { customerDiscountAmount: '50000', commissionAmount: '80000' },
  account: { email: 'binh@driver.local', displayName: 'Anh Bình' },
};

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server;
/** @type {Agent} */ let admin;
/** @type {Agent} */ let staff;
/** @type {Agent} */ let manager;
/** @type {Agent} */ let platform;
/** @type {Agent} */ let otherAdmin;
/** @type {Agent} */ let hotelAdmin;
/** @type {Agent} */ let driver;
/** @type {any} */ let hotel;
/** @type {any} */ let driverPartner;
/** @type {string} */ let payoutId;

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
  const accept = await new Agent(server.baseUrl).post('/api/v1/auth/invitations/accept', { token: tokenFromLink(res.body.invitation.inviteUrl), password: NEW_PASSWORD });
  assert.equal(accept.status, 200);
  return { partner: res.body.partner, agent: await signedIn(body.account.email, NEW_PASSWORD) };
}

/** A guest takes a voucher from the partner QR; returns the code and the guest's phone. @param {string} token */
async function activated(token) {
  const phone = new Agent(server.baseUrl);
  await phone.get(`/api/v1/public/referrals/${token}`);
  const res = await phone.post(`/api/v1/public/referrals/${token}/activate`);
  assert.equal(res.status, 201);
  return { code: /** @type {string} */ (res.body.voucher.code), phone };
}

/** Counter sends the bill, the guest confirms it. @param {string} token @param {string} grossAmount */
async function redeemed(token, grossAmount) {
  const { code, phone } = await activated(token);
  const sent = await staff.post(`/api/v1/vouchers/${code}/confirmations`, { grossAmount });
  assert.equal(sent.status, 201);
  assert.equal((await phone.post(`/api/v1/public/confirmations/${sent.body.confirmation.id}/confirm`)).status, 200);
  return code;
}

/** The guest's phone is gone: staff adds a bill photo and records it; the commission waits for review. @param {string} token */
async function waitingForReview(token) {
  const { code } = await activated(token);
  const sent = await staff.post(`/api/v1/vouchers/${code}/confirmations`, { grossAmount: '1000000' });
  const photo = await sharp({ create: { width: 600, height: 900, channels: 3, background: '#F4F1EA' } }).jpeg().toBuffer();
  const upload = await fetch(`${server.baseUrl}/api/v1/vouchers/${code}/bill-photos`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', cookie: staff.cookie, 'x-forwarded-for': staff.ip },
    body: photo,
  });
  assert.equal(upload.status, 201);
  assert.equal((await staff.post(`/api/v1/confirmations/${sent.body.confirmation.id}/fallback`, { reason: 'NEW_PHONE' })).status, 200);
  return code;
}

before(async () => {
  await resetDatabase();
  const other = await ensureTenant('Other Shop');
  await ensureActiveUser({ email: 'admin@other.local', displayName: 'Other Admin', password: PASSWORD, role: ROLES.TENANT_ADMIN, tenantId: other });
  server = await startServer();
  admin = await signedIn('admin@number160.local');
  staff = await signedIn('staff@number160.local');
  manager = await signedIn('manager@number160.local');
  platform = await signedIn('platform@connect.local');
  otherAdmin = await signedIn('admin@other.local');
  ({ partner: hotel, agent: hotelAdmin } = await partnerWithAccount(HOTEL));
  ({ partner: driverPartner, agent: driver } = await partnerWithAccount(DRIVER));

  for (const bill of ['2600000', '1000000', '500000']) await redeemed(hotel.qr.token, bill);
  await redeemed(driverPartner.qr.token, '1000000');
  await waitingForReview(hotel.qr.token);
  const paid = await admin.post(`/api/v1/partners/${hotel.id}/payouts`, { note: 'Bank transfer 02/10' });
  assert.equal(paid.status, 201);
  payoutId = paid.body.payout.id;
  const voided = await redeemed(hotel.qr.token, '800000');
  assert.equal((await manager.post(`/api/v1/vouchers/${voided}/void-redemption`, { reason: 'Wrong bill' })).status, 200);
  await redeemed(hotel.qr.token, '1200000');
});

after(async () => {
  await server?.close();
});

describe('@permission HIS-01 commission history scope', () => {
  it('the partner sees only its own bills, waiting ones first, without voucher codes', async () => {
    const res = await hotelAdmin.get('/api/v1/my/partner/history');
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.items.map((/** @type {any} */ item) => item.status),
      ['PENDING', 'OPEN', 'VOID', 'PAID', 'PAID', 'PAID'],
    );
    assert.ok(res.body.items.every((/** @type {any} */ item) => item.amount === '150000.0000'));
    assert.equal(res.body.next, null);
    assert.doesNotMatch(JSON.stringify(res.body), /"code"|voucherId|80000|payable|customerName|redeemedBy/);

    const own = await driver.get('/api/v1/my/partner/history');
    assert.deepEqual(own.body.items.map((/** @type {any} */ item) => item.amount), ['80000.0000']);
  });

  it('filters by status and period; refuses unknown values', async () => {
    const paid = await hotelAdmin.get('/api/v1/my/partner/history?status=PAID&period=this_month');
    assert.deepEqual(paid.body.items.map((/** @type {any} */ item) => item.status), ['PAID', 'PAID', 'PAID']);
    assert.ok(paid.body.items.every((/** @type {any} */ item) => item.payoutId === payoutId && item.paidAt));
    const waiting = await hotelAdmin.get('/api/v1/my/partner/history?status=PENDING');
    assert.equal(waiting.body.items.length, 1);
    assert.equal(waiting.body.items[0].baseAmount, '900000.0000');
    assert.equal((await hotelAdmin.get('/api/v1/my/partner/history?period=last_month')).body.items.length, 0);
    assert.equal((await hotelAdmin.get('/api/v1/my/partner/history?status=LOST')).status, 422);
    assert.equal((await hotelAdmin.get('/api/v1/my/partner/history?period=year')).status, 422);
    assert.equal((await hotelAdmin.get('/api/v1/my/partner/history?before=yesterday')).status, 422);
  });

  it('a payment opens with its bills and the note, for its own partner only', async () => {
    const res = await hotelAdmin.get(`/api/v1/my/partner/payouts/${payoutId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.payout.note, 'Bank transfer 02/10');
    assert.equal(res.body.payout.paidByName, undefined);
    assert.equal(res.body.items.length, 3);
    assert.equal((await driver.get(`/api/v1/my/partner/payouts/${payoutId}`)).status, 404);
    assert.equal((await hotelAdmin.get('/api/v1/my/partner/payouts/not-a-uuid')).status, 404);
  });

  it('merchant history: Merchant and Platform admin only; another merchant gets 404', async () => {
    const path = `/api/v1/partners/${hotel.id}/history`;
    assert.equal((await manager.get(path)).status, 403);
    assert.equal((await staff.get(path)).status, 403);
    assert.equal((await hotelAdmin.get(path)).status, 403);
    assert.equal((await otherAdmin.get(path)).status, 404);
    assert.equal((await otherAdmin.get(`/api/v1/partners/${hotel.id}/payouts/${payoutId}`)).status, 404);
    assert.equal((await platform.get(path)).status, 200);
    assert.equal((await admin.get(`/api/v1/partners/${driverPartner.id}/payouts/${payoutId}`)).status, 404);
    assert.equal((await staff.get('/api/v1/my/partner/history')).status, 403);
  });

  it('dashboard: Manager sees counts and discounts but no commission; Staff and partners are refused', async () => {
    const res = await manager.get('/api/v1/dashboard');
    assert.equal(res.status, 200);
    assert.equal(res.body.withCommission, false);
    assert.equal(res.body.commission, undefined);
    assert.equal(res.body.work, undefined);
    assert.ok(res.body.month.redemptions > 0);
    assert.equal((await staff.get('/api/v1/dashboard')).status, 403);
    assert.equal((await hotelAdmin.get('/api/v1/dashboard')).status, 403);
  });
});

describe('@money HIS-02 totals match', () => {
  it('history totals match the partner numbers on /my', async () => {
    const history = (await hotelAdmin.get('/api/v1/my/partner/history?period=this_month')).body;
    const { stats } = (await hotelAdmin.get('/api/v1/my/partner')).body;
    assert.equal(history.totals.OPEN.amount, stats.commissionOpen);
    assert.equal(history.totals.PAID.amount, stats.commissionPaid);
    assert.equal(history.totals.PENDING.amount, stats.commissionPending);
    assert.equal(history.totals.PENDING.count, stats.pendingReviews);
    assert.deepEqual(history.totals.VOID, { amount: '150000.0000', count: 1 });
  });

  it('merchant history shows voucher codes and the payouts with who recorded them; a payout adds up', async () => {
    const res = await admin.get(`/api/v1/partners/${hotel.id}/history`);
    assert.equal(res.status, 200);
    assert.equal(res.body.partner.name, HOTEL.name);
    assert.ok(res.body.items.every((/** @type {any} */ item) => VOUCHER_CODE_PATTERN.test(item.code)));
    assert.deepEqual(
      res.body.payouts.map((/** @type {any} */ p) => ({ amount: p.amount, itemCount: p.itemCount, note: p.note, by: p.paidByName })),
      [{ amount: '450000.0000', itemCount: 3, note: 'Bank transfer 02/10', by: 'Tenant Admin' }],
    );
    const detail = await admin.get(`/api/v1/partners/${hotel.id}/payouts/${payoutId}`);
    assert.equal(detail.body.payout.paidByName, 'Tenant Admin');
    assert.equal(sumAmounts(detail.body.items.map((/** @type {any} */ item) => item.amount)), detail.body.payout.amount);
  });

  it('dashboard numbers match the stored redemptions, commission and payouts', async () => {
    const tenantId = hotel.merchantId;
    const now = new Date();
    const vouchers = await collection('vouchers');
    const done = await vouchers.find({ tenantId, status: 'REDEEMED', 'redemption.redeemedAt': { $gte: vnMonthStart(now) } }).toArray();
    const today = done.filter((v) => v.redemption.redeemedAt >= vnDayStart(now));

    const res = await admin.get('/api/v1/dashboard');
    assert.equal(res.status, 200);
    assert.equal(res.body.month.redemptions, done.length);
    assert.equal(res.body.month.billTotal, sumAmounts(done.map((v) => fromDecimal128(v.redemption.grossAmount))));
    assert.equal(res.body.month.discountTotal, sumAmounts(done.map((v) => fromDecimal128(v.redemption.discountAmount))));
    assert.equal(res.body.today.redemptions, today.length);
    assert.equal(res.body.month.newVouchers, await vouchers.countDocuments({ tenantId, createdAt: { $gte: vnMonthStart(now) } }));
    // Unpaid: hotel 150,000 (last bill) + driver 80,000; paid this month: the 450,000 payout.
    assert.deepEqual(res.body.commission, {
      unpaid: '230000.0000',
      unpaidPartners: 2,
      paidThisMonth: '450000.0000',
      paymentsThisMonth: 1,
      waitingAmount: '150000.0000',
      waitingBills: 1,
    });
    assert.deepEqual(res.body.work.reviews, [{ partnerId: hotel.id, name: HOTEL.name, count: 1, amount: '150000.0000' }]);
    assert.deepEqual(
      res.body.work.unpaid.map((/** @type {any} */ row) => [row.name, row.amount]),
      [
        [HOTEL.name, '150000.0000'],
        [DRIVER.name, '80000.0000'],
      ],
    );

    const all = await platform.get('/api/v1/dashboard');
    assert.equal(all.body.work.reviews[0].merchantName, 'Number160');
    const empty = await otherAdmin.get('/api/v1/dashboard');
    assert.deepEqual(empty.body.month, { redemptions: 0, billTotal: '0.0000', discountTotal: '0.0000', newVouchers: 0 });
    assert.equal(empty.body.commission.unpaid, '0.0000');
  });
});

describe('HIS-03 paging', () => {
  it('pages of 20, newest first, no bill twice; last month apart', async () => {
    const created = await admin.post('/api/v1/partners', { name: 'Đại lý Nhiều Bill', relationshipKind: 'COMPANY', partnerType: 'OTHER', rule: HOTEL.rule });
    assert.equal(created.status, 201);
    const partner = created.body.partner;
    const monthStart = vnMonthStart(new Date()).getTime();
    const base = Math.max(Date.now(), monthStart + 3_600_000);
    const lastMonth = new Date(monthStart - 86_400_000);
    const docs = Array.from({ length: 23 }, (_, index) => ({
      _id: randomUUID(),
      tenantId: partner.merchantId,
      voucherId: randomUUID(),
      redemptionId: randomUUID(),
      partnerId: partner.id,
      mediumId: null,
      ruleId: null,
      ruleVersion: null,
      obligationType: 'TENANT_TO_COMPANY',
      rate: toDecimal128('0.0000'),
      baseAmount: toDecimal128('1000000.0000'),
      amount: toDecimal128('150000.0000'),
      status: 'OPEN',
      redeemedAt: index === 22 ? lastMonth : new Date(base - index * 60_000),
      createdAt: new Date(),
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
    }));
    docs[6].redeemedAt = docs[5].redeemedAt;
    await (await collection('commissionItems')).insertMany(docs);

    const path = `/api/v1/partners/${partner.id}/history`;
    const first = await admin.get(path);
    assert.equal(first.body.items.length, 20);
    assert.ok(first.body.next);
    assert.ok(first.body.payouts);
    const second = await admin.get(`${path}?before=${encodeURIComponent(first.body.next)}`);
    assert.equal(second.body.items.length, 3);
    assert.equal(second.body.next, null);
    assert.equal(second.body.payouts, undefined);
    const ids = [...first.body.items, ...second.body.items].map((/** @type {any} */ item) => item.id);
    assert.equal(new Set(ids).size, 23);
    const times = [...first.body.items, ...second.body.items].map((/** @type {any} */ item) => item.redeemedAt);
    assert.deepEqual(times, [...times].sort().reverse());

    const thisMonth = await admin.get(`${path}?period=this_month`);
    assert.equal(thisMonth.body.totals.OPEN.count, 22);
    const previous = await admin.get(`${path}?period=last_month`);
    assert.deepEqual(previous.body.items.map((/** @type {any} */ item) => item.redeemedAt), [lastMonth.toISOString()]);
  });
});
