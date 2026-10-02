import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { ROLES, sumAmounts } from '#domain';
import { ensureActiveUser, ensureTenant } from '../src/db/bootstrap.js';
import { toDecimal128 } from '../src/db/decimal.js';
import { collection } from '../src/db/mongo.js';
import { seedPartners } from '../src/db/seed-local.js';
import { reportPeriod, toCsv } from '../src/partners/report.js';
import { Agent, PASSWORD, resetDatabase, startServer, tokenFromLink } from './helpers.js';

const NEW_PASSWORD = 'Welcome#2026';
const HOTEL = {
  name: 'Khách sạn Báo Cáo',
  relationshipKind: 'COMPANY',
  partnerType: 'HOTEL',
  rule: { customerDiscountAmount: '100000', commissionAmount: '150000' },
  account: { email: 'lan@baocao.local', displayName: 'Chị Lan' },
};
const DRIVER = {
  name: 'Anh Bình',
  relationshipKind: 'INDEPENDENT_INDIVIDUAL',
  partnerType: 'DRIVER',
  rule: { customerDiscountAmount: '50000', commissionAmount: '80000' },
  account: { email: 'binh@baocao.local', displayName: 'Anh Bình' },
};
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SHOWN_CODE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const MERCHANT_HEADER = 'date,voucher_code,partner,bill,guest_paid,commission,commission_status,paid_date,payout_note';
const PARTNER_HEADER = 'date,guest_paid,commission,commission_status,paid_date,payout_note';

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
/** @type {string[]} */ const hotelCodes = [];

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

/** @param {string} token */
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

/** The guest could not confirm: staff records it with a bill photo; returns the code and the review id. @param {string} token */
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
  const voucher = await (await collection('vouchers')).findOne({ code });
  const review = await (await collection('commissionReviews')).findOne({ voucherId: voucher?._id, status: 'PENDING' });
  return { code, reviewId: /** @type {string} */ (review?._id) };
}

/**
 * A redeemed partner voucher written straight to the database, for bills at a chosen time.
 * @param {{ tenantId: string, partnerId: string, redeemedAt: Date, gross: string, discount: string, commission: string }} bill
 */
async function insertBill({ tenantId, partnerId, redeemedAt, gross, discount, commission }) {
  const code = Array.from({ length: 8 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  const redemptionId = randomUUID();
  const voucherId = randomUUID();
  const payable = sumAmounts([gross, `-${discount}`]);
  await (await collection('vouchers')).insertOne({
    _id: voucherId,
    tenantId,
    code,
    source: 'REFERRAL',
    status: 'REDEEMED',
    partnerId,
    discountType: 'AMOUNT',
    discountValue: toDecimal128(discount),
    validUntil: new Date(redeemedAt.getTime() + 30 * 86_400_000),
    createdBy: randomUUID(),
    createdAt: new Date(redeemedAt.getTime() - 3_600_000),
    redemption: {
      id: redemptionId,
      grossAmount: toDecimal128(gross),
      discountAmount: toDecimal128(discount),
      payableAmount: toDecimal128(payable),
      redeemedBy: randomUUID(),
      roleAssignmentId: null,
      redeemedAt,
    },
  });
  await (await collection('commissionItems')).insertOne({
    _id: randomUUID(),
    tenantId,
    voucherId,
    redemptionId,
    partnerId,
    mediumId: null,
    ruleId: null,
    ruleVersion: null,
    obligationType: 'TENANT_TO_COMPANY',
    rate: toDecimal128('0.0000'),
    baseAmount: toDecimal128(payable),
    amount: toDecimal128(commission),
    status: 'OPEN',
    redeemedAt,
    createdAt: redeemedAt,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
  });
  return code;
}

/** @param {Agent} agent @param {string} path */
async function csvOf(agent, path) {
  const res = await fetch(agent.baseUrl + path, { headers: { cookie: agent.cookie, 'x-forwarded-for': agent.ip } });
  const buffer = Buffer.from(await res.arrayBuffer());
  const text = buffer.toString('utf8');
  return { res, buffer, text, lines: text.replace(/^\uFEFF/, '').split('\r\n') };
}

/** @param {string} line */
const cells = (line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => match[1].replace(/""/g, '"'));

before(async () => {
  await resetDatabase();
  await seedPartners(PASSWORD);
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

  for (const bill of ['2600000', '1000000']) hotelCodes.push(await redeemed(hotel.qr.token, bill));
  assert.equal((await admin.post(`/api/v1/partners/${hotel.id}/payouts`, { note: 'Bank transfer 02/10' })).status, 201);
  hotelCodes.push((await waitingForReview(hotel.qr.token)).code);
  const voided = await redeemed(hotel.qr.token, '800000');
  hotelCodes.push(voided);
  assert.equal((await manager.post(`/api/v1/vouchers/${voided}/void-redemption`, { reason: 'Wrong bill' })).status, 200);
  hotelCodes.push(await redeemed(hotel.qr.token, '1200000'));

  await redeemed(driverPartner.qr.token, '1000000');
  const rejected = await waitingForReview(driverPartner.qr.token);
  assert.equal((await admin.post(`/api/v1/commission-reviews/${rejected.reviewId}/reject`, { note: 'No such bill' })).status, 200);
});

after(async () => {
  await server?.close();
});

describe('@money REP-01 report per partner', () => {
  it('counts bills that stand and splits commission per status, with a totals row', async () => {
    const res = await admin.get('/api/v1/reports/commission');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.partners.map((/** @type {any} */ row) => row.name), [DRIVER.name, HOTEL.name]);
    const [driverRow, hotelRow] = res.body.partners;
    assert.deepEqual(hotelRow, {
      partnerId: hotel.id,
      name: HOTEL.name,
      redemptions: 4,
      voidedBills: 1,
      billTotal: '5800000.0000',
      discountTotal: '400000.0000',
      commission: { OPEN: '150000.0000', PAID: '300000.0000', PENDING: '150000.0000', VOID: '150000.0000' },
    });
    assert.deepEqual(driverRow, {
      partnerId: driverPartner.id,
      name: DRIVER.name,
      redemptions: 2,
      voidedBills: 0,
      billTotal: '2000000.0000',
      discountTotal: '100000.0000',
      commission: { OPEN: '80000.0000', PAID: '0.0000', PENDING: '0.0000', VOID: '0.0000' },
    });
    assert.deepEqual(res.body.totals, {
      redemptions: 6,
      voidedBills: 1,
      billTotal: '7800000.0000',
      discountTotal: '500000.0000',
      commission: { OPEN: '230000.0000', PAID: '300000.0000', PENDING: '150000.0000', VOID: '150000.0000' },
    });
    assert.match(res.body.period.from, /^\d{4}-\d{2}-01$/);

    const one = await admin.get(`/api/v1/reports/commission?partnerId=${hotel.id.toUpperCase()}`);
    assert.deepEqual(one.body.partners.map((/** @type {any} */ row) => row.name), [HOTEL.name]);
    const previous = await admin.get('/api/v1/reports/commission?period=last_month');
    assert.deepEqual(previous.body.partners, []);
    assert.equal(previous.body.totals.billTotal, '0.0000');
  });
});

describe('@money REP-02 totals reconcile', () => {
  it('equal Overview, the partner cards, the history totals and the payouts for the same data', async () => {
    const report = (await admin.get('/api/v1/reports/commission?period=this_month')).body;
    assert.equal(await (await collection('vouchers')).countDocuments({ tenantId: hotel.merchantId, source: 'DIRECT', status: 'REDEEMED' }), 0);
    const dashboard = (await admin.get('/api/v1/dashboard')).body;
    assert.equal(dashboard.month.redemptions, report.totals.redemptions);
    assert.equal(dashboard.month.billTotal, report.totals.billTotal);
    assert.equal(dashboard.month.discountTotal, report.totals.discountTotal);
    assert.equal(dashboard.commission.unpaid, report.totals.commission.OPEN);
    assert.equal(dashboard.commission.paidThisMonth, report.totals.commission.PAID);
    assert.equal(dashboard.commission.waitingAmount, report.totals.commission.PENDING);

    const { partners } = (await admin.get('/api/v1/partners')).body;
    for (const row of report.partners) {
      const card = partners.find((/** @type {any} */ p) => p.id === row.partnerId);
      assert.equal(card.stats.redemptions, row.redemptions, row.name);
      assert.equal(card.stats.commissionOpen, row.commission.OPEN, row.name);
      assert.equal(card.stats.commissionPaid, row.commission.PAID, row.name);
      assert.equal(card.stats.commissionPending, row.commission.PENDING, row.name);

      const history = (await admin.get(`/api/v1/partners/${row.partnerId}/history?period=this_month`)).body;
      for (const status of ['OPEN', 'PAID', 'PENDING', 'VOID']) assert.equal(history.totals[status].amount, row.commission[status], `${row.name} ${status}`);
      assert.equal(sumAmounts(history.payouts.map((/** @type {any} */ p) => p.amount)), row.commission.PAID, row.name);
    }
  });
});

describe('REP-03 period', () => {
  it('whole days in Vietnam time: 23:30 on the last day is in, 00:10 the next day is out', async () => {
    const created = await otherAdmin.post('/api/v1/partners', { name: 'Đại lý Ranh Giới', relationshipKind: 'COMPANY', partnerType: 'OTHER', rule: HOTEL.rule });
    assert.equal(created.status, 201);
    const owner = { tenantId: created.body.partner.merchantId, partnerId: created.body.partner.id };
    const bill = { gross: '1000000.0000', discount: '100000.0000', commission: '150000.0000' };
    await insertBill({ ...owner, ...bill, redeemedAt: new Date('2025-03-30T23:59:00+07:00') });
    await insertBill({ ...owner, ...bill, redeemedAt: new Date('2025-03-31T00:00:00+07:00') });
    await insertBill({ ...owner, ...bill, redeemedAt: new Date('2025-03-31T23:30:00+07:00') });
    await insertBill({ ...owner, ...bill, redeemedAt: new Date('2025-04-01T00:10:00+07:00') });

    const day = await otherAdmin.get('/api/v1/reports/commission?from=2025-03-31&to=2025-03-31');
    assert.equal(day.status, 200);
    assert.deepEqual(day.body.period, { from: '2025-03-31', to: '2025-03-31' });
    assert.equal(day.body.totals.redemptions, 2);
    assert.equal(day.body.totals.commission.OPEN, '300000.0000');
    const csv = await csvOf(otherAdmin, '/api/v1/reports/commission/csv?from=2025-03-31&to=2025-03-31');
    assert.deepEqual(csv.lines.slice(1).map((line) => cells(line)[0]), ['2025-03-31 00:00', '2025-03-31 23:30']);
    assert.equal((await otherAdmin.get('/api/v1/reports/commission?from=2025-04-01&to=2025-04-01')).body.totals.redemptions, 1);
    assert.equal((await otherAdmin.get('/api/v1/reports/commission?from=2025-03-01&to=2025-04-30')).body.totals.redemptions, 4);
    assert.equal((await admin.get('/api/v1/reports/commission?from=2025-03-01&to=2025-04-30')).body.totals.redemptions, 0);
  });

  it('this month and last month follow the Vietnam calendar', () => {
    const now = new Date('2026-10-31T17:30:00Z');
    const pick = (/** @type {string} */ query) => {
      const { from, to, range } = reportPeriod(new URLSearchParams(query), now);
      return { from, to, start: range.$gte.toISOString(), end: range.$lt.toISOString() };
    };
    assert.deepEqual(pick(''), { from: '2026-11-01', to: '2026-11-30', start: '2026-10-31T17:00:00.000Z', end: '2026-11-30T17:00:00.000Z' });
    assert.deepEqual(pick('period=last_month'), { from: '2026-10-01', to: '2026-10-31', start: '2026-09-30T17:00:00.000Z', end: '2026-10-31T17:00:00.000Z' });
    assert.deepEqual(pick('from=2024-01-01&to=2024-12-31'), { from: '2024-01-01', to: '2024-12-31', start: '2023-12-31T17:00:00.000Z', end: '2024-12-31T17:00:00.000Z' });
  });

  it('refuses bad dates with 422 VALIDATION', async () => {
    const bad = [
      'from=2026-13-01&to=2026-12-31',
      'from=2026-02-30&to=2026-03-01',
      'from=2026/10/01&to=2026-10-02',
      'from=2026-10-01',
      'to=2026-10-01',
      'from=2026-10-02&to=2026-10-01',
      'from=2025-01-01&to=2026-01-02',
      'period=year',
      'period=this_month&from=2026-10-01&to=2026-10-02',
    ];
    for (const query of bad) {
      for (const [agent, path] of /** @type {const} */ ([
        [admin, '/api/v1/reports/commission'],
        [admin, '/api/v1/reports/commission/csv'],
        [hotelAdmin, '/api/v1/my/partner/report/csv'],
      ])) {
        const res = await agent.get(`${path}?${query}`);
        assert.equal(res.status, 422, `${path}?${query}`);
        assert.equal(res.body.error.code, 'VALIDATION');
      }
    }
    assert.equal((await admin.get('/api/v1/reports/commission?from=2025-01-01&to=2026-01-01')).status, 200);
  });
});

describe('@money REP-04 merchant CSV', () => {
  it('one row per bill with codes XXXX-XXXX; UTF-8 BOM, CRLF and quoted cells; amounts add up', async () => {
    const { res, buffer, text, lines } = await csvOf(admin, '/api/v1/reports/commission/csv');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="commission-\d{4}-\d{2}-01_\d{4}-\d{2}-\d{2}\.csv"$/);
    assert.deepEqual([...buffer.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(text.replace(/\r\n/g, '').includes('\n'), false);
    assert.equal(cells(lines[0]).join(','), MERCHANT_HEADER);
    const rows = lines.slice(1).map(cells);
    assert.equal(rows.length, 7);
    assert.ok(rows.every((row) => row.length === 9 && SHOWN_CODE.test(row[1]) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(row[0])));
    assert.deepEqual(
      rows.filter((row) => row[2] === HOTEL.name).map((row) => [row[3], row[4], row[5], row[6]]),
      [
        ['2600000.0000', '2500000.0000', '150000.0000', 'PAID'],
        ['1000000.0000', '900000.0000', '150000.0000', 'PAID'],
        ['1000000.0000', '900000.0000', '150000.0000', 'WAITING_FOR_REVIEW'],
        ['800000.0000', '700000.0000', '150000.0000', 'VOID'],
        ['1200000.0000', '1100000.0000', '150000.0000', 'UNPAID'],
      ],
    );
    assert.deepEqual(rows.filter((row) => row[2] === HOTEL.name).map((row) => row[1].replace('-', '')), hotelCodes);
    const paid = rows.filter((row) => row[6] === 'PAID');
    assert.ok(paid.every((row) => /^\d{4}-\d{2}-\d{2}$/.test(row[7]) && row[8] === 'Bank transfer 02/10'));
    assert.deepEqual(rows.filter((row) => row[2] === DRIVER.name).map((row) => [row[5], row[6]]), [
      ['80000.0000', 'UNPAID'],
      ['0.0000', 'REJECTED'],
    ]);
    const report = (await admin.get('/api/v1/reports/commission')).body;
    assert.equal(sumAmounts(rows.filter((row) => row[6] === 'UNPAID').map((row) => row[5])), report.totals.commission.OPEN);
    assert.equal(sumAmounts(rows.filter((row) => row[6] !== 'VOID').map((row) => row[3])), report.totals.billTotal);
  });

  it('quotes cells and neutralises formulas', () => {
    assert.equal(toCsv([['a', 'b'], ['=SUM(A1)', 'say "hi"', '-1', '@x', 'Lê Văn']]), '\uFEFF"a","b"\r\n"\'=SUM(A1)","say ""hi""","\'-1","\'@x","Lê Văn"');
  });
});

describe('@permission REP-05 partner CSV', () => {
  it('only its own bills, without voucher codes, partner names or the bill before discount', async () => {
    const { res, text, lines } = await csvOf(hotelAdmin, '/api/v1/my/partner/report/csv');
    assert.equal(res.status, 200);
    assert.ok(text.startsWith('\uFEFF'));
    assert.equal(cells(lines[0]).join(','), PARTNER_HEADER);
    const rows = lines.slice(1).map(cells);
    assert.deepEqual(rows.map((row) => [row[1], row[3]]), [
      ['2500000.0000', 'PAID'],
      ['900000.0000', 'PAID'],
      ['900000.0000', 'WAITING_FOR_REVIEW'],
      ['700000.0000', 'VOID'],
      ['1100000.0000', 'UNPAID'],
    ]);
    for (const code of hotelCodes) {
      assert.equal(text.includes(code), false);
      assert.equal(text.includes(`${code.slice(0, 4)}-${code.slice(4)}`), false);
    }
    assert.doesNotMatch(text, /2600000|voucher_code|Khách sạn|Anh Bình/);

    const own = await csvOf(driver, '/api/v1/my/partner/report/csv');
    assert.deepEqual(own.lines.slice(1).map((line) => cells(line).slice(2, 4)), [
      ['80000.0000', 'UNPAID'],
      ['0.0000', 'REJECTED'],
    ]);
  });

  it('a partner of two merchants only gets the bills of the merchant it signed in for', async () => {
    const tenants = await collection('tenants');
    const partners = await collection('partners');
    const restaurant = await tenants.findOne({ name: 'Nhà hàng Demo' });
    const atRestaurant = await partners.findOne({ tenantId: restaurant?._id, name: 'Khách sạn Demo' });
    const atSpa = await partners.findOne({ tenantId: hotel.merchantId, name: 'Khách sạn Demo' });
    const now = new Date();
    await insertBill({ tenantId: restaurant?._id, partnerId: atRestaurant?._id, redeemedAt: now, gross: '600000.0000', discount: '50000.0000', commission: '80000.0000' });
    await insertBill({ tenantId: hotel.merchantId, partnerId: atSpa?._id, redeemedAt: now, gross: '2000000.0000', discount: '100000.0000', commission: '150000.0000' });

    const partner = new Agent(server.baseUrl);
    const login = await partner.login('partner@number160.local');
    const roleAt = (/** @type {string} */ name) => login.body.roles.find((/** @type {any} */ r) => r.tenantName === name).roleAssignmentId;
    assert.equal((await partner.get('/api/v1/my/partner/report/csv')).status, 403);
    await partner.post('/api/v1/auth/select-role', { roleAssignmentId: roleAt('Nhà hàng Demo') });
    assert.deepEqual((await csvOf(partner, '/api/v1/my/partner/report/csv')).lines.slice(1).map((line) => cells(line).slice(1, 3)), [['550000.0000', '80000.0000']]);
    await partner.post('/api/v1/auth/select-role', { roleAssignmentId: roleAt('Number160') });
    assert.deepEqual((await csvOf(partner, '/api/v1/my/partner/report/csv')).lines.slice(1).map((line) => cells(line).slice(1, 3)), [['1900000.0000', '150000.0000']]);
    assert.equal((await partner.get('/api/v1/reports/commission')).status, 403);
  });
});

describe('@permission REP-06 access', () => {
  it('Merchant admin only: Manager, Staff, Platform admin and partners get 403; no session 401', async () => {
    for (const path of ['/api/v1/reports/commission', '/api/v1/reports/commission/csv']) {
      for (const agent of [manager, staff, platform, hotelAdmin]) {
        const res = await agent.get(path);
        assert.equal(res.status, 403, path);
        assert.equal(res.body.error.code, 'FORBIDDEN');
      }
      assert.equal((await new Agent(server.baseUrl).get(path)).status, 401);
    }
    for (const agent of [admin, manager, staff]) assert.equal((await agent.get('/api/v1/my/partner/report/csv')).status, 403);
  });

  it("another merchant's partner is not found", async () => {
    for (const path of ['/api/v1/reports/commission', '/api/v1/reports/commission/csv']) {
      const res = await otherAdmin.get(`${path}?partnerId=${hotel.id}`);
      assert.equal(res.status, 404, path);
      assert.equal(res.body.error.code, 'PARTNER_NOT_FOUND');
      assert.equal((await admin.get(`${path}?partnerId=not-a-uuid`)).status, 404);
    }
    const own = await csvOf(otherAdmin, '/api/v1/reports/commission/csv');
    assert.equal(own.lines.length, 1, 'header only: no Number160 bill');
  });
});
