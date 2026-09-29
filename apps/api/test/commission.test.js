import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ROLES } from '#domain';
import { ensureActiveUser, ensureTenant } from '../src/db/bootstrap.js';
import { fromDecimal128 } from '../src/db/decimal.js';
import { collection } from '../src/db/mongo.js';
import { Agent, PASSWORD, resetDatabase, startServer, tokenFromLink } from './helpers.js';

const NEW_PASSWORD = 'Welcome#2026';
/** Plan §7.1 fixture: VAT 10 %, guest discount 7 %, company commission 8 %. */
const HOTEL = {
  name: 'Khách sạn Hoa Sen',
  relationshipKind: 'COMPANY',
  partnerType: 'HOTEL',
  rule: { totalBudgetPercent: '15', customerDiscountPercent: '7' },
  account: { email: 'mai@hoasen.local', displayName: 'Chị Mai' },
};
const DRIVER = {
  name: 'Anh Tuấn',
  relationshipKind: 'INDEPENDENT_INDIVIDUAL',
  partnerType: 'DRIVER',
  rule: { totalBudgetPercent: '12', customerDiscountPercent: '5' },
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

/** A customer taps the partner QR and gets a voucher code. @param {string} token */
async function activated(token) {
  const phone = new Agent(server.baseUrl);
  await phone.get(`/api/v1/public/referrals/${token}`);
  const res = await phone.post(`/api/v1/public/referrals/${token}/activate`);
  assert.equal(res.status, 201);
  return /** @type {string} */ (res.body.voucher.code);
}

before(async () => {
  await resetDatabase();
  const other = await ensureTenant('Other Shop');
  await ensureActiveUser({ email: 'admin@other.local', displayName: 'Other Admin', password: PASSWORD, role: ROLES.TENANT_ADMIN, tenantId: other });
  server = await startServer();
  admin = await signedIn('admin@number160.local');
  staff = await signedIn('staff@number160.local');
  manager = await signedIn('manager@number160.local');
  assert.equal((await admin.post('/api/v1/merchant/settings', { vatPercent: '10' })).status, 200);
  ({ partner: hotel, agent: hotelAdmin } = await partnerWithAccount(HOTEL));
  ({ partner: driverPartner, agent: driver } = await partnerWithAccount(DRIVER));
});

after(async () => {
  await server?.close();
});

describe('@money referral redemption', () => {
  /** @type {string} */
  let code;

  it('the §7.1 fixture: bill 2,600,000 gives exactly the stored amounts; Staff sees no commission', async () => {
    code = await activated(hotel.qr.token);
    const res = await staff.post(`/api/v1/vouchers/${code}/redeem`, { grossAmount: '2600000' });
    assert.equal(res.status, 200);
    const shown = res.body.voucher;
    assert.deepEqual(
      { gross: shown.redemption.grossAmount, discount: shown.redemption.discountAmount, payable: shown.redemption.payableAmount },
      { gross: '2600000.0000', discount: '182000.0000', payable: '2418000.0000' },
    );
    assert.doesNotMatch(JSON.stringify(res.body), /commission|175854|netNet|partner/i);

    const vouchers = await collection('vouchers');
    const stored = await vouchers.findOne({ code });
    assert.equal(fromDecimal128(stored?.redemption.netNetCommissionBase), '2198181.8182');
    assert.equal(fromDecimal128(stored?.redemption.vatAmount), '219818.1818');
    assert.equal(fromDecimal128(stored?.redemption.vatRate), '0.1000');

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
        rate: '0.0800',
        base: '2198181.8182',
        amount: '175854.5455',
        status: 'OPEN',
        partnerId: hotel.id,
        redemptionId: stored?.redemption.id,
      },
    );
  });

  it('an independent individual gets TENANT_TO_INDEPENDENT_INDIVIDUAL on the same base rule', async () => {
    const driverCode = await activated(driverPartner.qr.token);
    assert.equal((await staff.post(`/api/v1/vouchers/${driverCode}/redeem`, { grossAmount: '1000000' })).status, 200);
    const vouchers = await collection('vouchers');
    const stored = await vouchers.findOne({ code: driverCode });
    const [item] = await (await collection('commissionItems')).find({ voucherId: stored?._id }).toArray();
    assert.equal(item.obligationType, 'TENANT_TO_INDEPENDENT_INDIVIDUAL');
    // 1,000,000 − 5 % = 950,000; ÷ 1.1 = 863,636.3636; × 7 % = 60,454.5455
    assert.equal(fromDecimal128(item.baseAmount), '863636.3636');
    assert.equal(fromDecimal128(item.amount), '60454.5455');
  });

  it('two counters confirming at once: one success, one 409, one set of commission items', async () => {
    const racing = await activated(hotel.qr.token);
    const other = await signedIn('manager@number160.local');
    const results = await Promise.all([
      staff.post(`/api/v1/vouchers/${racing}/redeem`, { grossAmount: '500000' }),
      other.post(`/api/v1/vouchers/${racing}/redeem`, { grossAmount: '500000' }),
    ]);
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

    assert.equal((await staff.post(`/api/v1/vouchers/${code}/redeem`, { grossAmount: '260000' })).status, 200);
    const open = await items.find({ voucherId: stored?._id, status: 'OPEN' }).toArray();
    assert.equal(open.length, 1);
    // 260,000 − 18,200 = 241,800; ÷ 1.1 = 219,818.1818; × 8 % = 17,585.4545
    assert.equal(fromDecimal128(open[0].amount), '17585.4545');
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
    // Open: 17,585.4545 (re-redeemed fixture voucher) + racing voucher 500,000 → 465,000 ÷ 1.1 = 422,727.2727 × 8 % = 33,818.1818
    assert.deepEqual(row.stats, { opens: 2, activations: 2, redemptions: 2, commissionOpen: '51403.6363' });

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
    assert.deepEqual(res.body.rule, { customerDiscountRate: '0.0700', commissionRate: '0.0800' });
    assert.equal(res.body.stats.commissionOpen, '51403.6363');
    assert.deepEqual(res.body.recent.map((/** @type {any} */ item) => item.status).sort(), ['OPEN', 'OPEN', 'VOID']);
    assert.doesNotMatch(JSON.stringify(res.body), /redeemedBy|customerName|payable|code/);

    const own = await driver.get('/api/v1/my/partner');
    assert.equal(own.body.partner.name, DRIVER.name);
    assert.equal(own.body.stats.commissionOpen, '60454.5455');
    assert.equal(own.body.recent.length, 1);
  });

  it('staff and merchant roles cannot open /my; partners cannot list partners', async () => {
    assert.equal((await staff.get('/api/v1/my/partner')).status, 403);
    assert.equal((await admin.get('/api/v1/my/partner')).status, 403);
    assert.equal((await hotelAdmin.get('/api/v1/partners')).status, 403);
  });
});
