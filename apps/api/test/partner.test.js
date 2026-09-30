import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ROLES } from '#domain';
import { ensureActiveUser, ensureTenant } from '../src/db/bootstrap.js';
import { collection } from '../src/db/mongo.js';
import { Agent, PASSWORD, resetDatabase, startServer, tokenFromLink } from './helpers.js';

const NEW_PASSWORD = 'Welcome#2026';
const HOTEL = {
  name: 'Khách sạn Hoa Sen',
  relationshipKind: 'COMPANY',
  partnerType: 'HOTEL',
  contactName: 'Chị Mai',
  contactPhone: '0905 111 222',
  rule: { customerDiscountAmount: '100000', commissionAmount: '150000' },
};

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server;

before(async () => {
  await resetDatabase();
  const other = await ensureTenant('Other Shop');
  await ensureActiveUser({ email: 'admin@other.local', displayName: 'Other Admin', password: PASSWORD, role: ROLES.TENANT_ADMIN, tenantId: other });
  server = await startServer();
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

describe('@money merchant settings', () => {
  it('no VAT: settings only carry the name and brand, and VAT can no longer be set', async () => {
    const admin = await signedIn('admin@number160.local');
    const settings = await admin.get('/api/v1/merchant/settings');
    assert.equal(settings.status, 200);
    assert.equal(settings.body.vatRate, undefined);
    assert.equal((await admin.post('/api/v1/merchant/settings', { vatPercent: '10' })).status, 405);
  });
});

describe('@money @permission partners and commercial rules', () => {
  /** @type {string} */
  let hotelId;

  it('Merchant admin creates a company partner with a fixed discount and a fixed commission, no VAT needed', async () => {
    const admin = await signedIn('admin@number160.local');
    const res = await admin.post('/api/v1/partners', HOTEL);
    assert.equal(res.status, 201);
    const { partner } = res.body;
    hotelId = partner.id;
    assert.equal(partner.status, 'ACTIVE');
    assert.equal(partner.merchantName, 'Number160');
    assert.deepEqual(
      { ...partner.rule, id: undefined, effectiveFrom: undefined },
      {
        id: undefined,
        effectiveFrom: undefined,
        version: 1,
        pricingModel: 'FIXED_AMOUNT',
        customerDiscountAmount: '100000.0000',
        commissionAmount: '150000.0000',
        totalBudgetRate: '0.0000',
        customerDiscountRate: '0.0000',
        companyCommissionRate: null,
        individualShareRate: null,
        companyNetCommissionRate: null,
        individualCommissionRate: null,
      },
    );
    const rules = await collection('commercialRules');
    const stored = await rules.findOne({ partnerId: hotelId });
    assert.equal(stored?.commissionAmount._bsontype, 'Decimal128');
  });

  it('refuses a zero, fractional or percent-only rule', async () => {
    const admin = await signedIn('admin@number160.local');
    const zero = await admin.post('/api/v1/partners', { ...HOTEL, name: 'Zero', rule: { customerDiscountAmount: '0', commissionAmount: '1000.5' } });
    assert.equal(zero.status, 422);
    assert.equal(zero.body.error.code, 'COMMERCIAL_RULE_INVALID');
    assert.deepEqual(zero.body.error.details.reasons, ['CUSTOMER_DISCOUNT_AMOUNT_INVALID', 'COMMISSION_AMOUNT_INVALID']);
    const percent = await admin.post('/api/v1/partners', { ...HOTEL, name: 'Old', rule: { totalBudgetPercent: '15', customerDiscountPercent: '7' } });
    assert.equal(percent.status, 422);
  });

  it('refuses a duplicate name within the merchant, case-insensitive', async () => {
    const admin = await signedIn('admin@number160.local');
    const res = await admin.post('/api/v1/partners', { ...HOTEL, name: 'KHÁCH SẠN  HOA SEN' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'PARTNER_EXISTS');
  });

  it('changing the rule creates version 2 and supersedes version 1', async () => {
    const admin = await signedIn('admin@number160.local');
    const res = await admin.post(`/api/v1/partners/${hotelId}/rule`, { customerDiscountAmount: '120000', commissionAmount: '150000' });
    assert.equal(res.status, 200);
    assert.equal(res.body.partner.rule.version, 2);
    assert.equal(res.body.partner.rule.customerDiscountAmount, '120000.0000');
    const same = await admin.post(`/api/v1/partners/${hotelId}/rule`, { customerDiscountAmount: '120000', commissionAmount: '150000' });
    assert.equal(same.body.partner.rule.version, 2);
    const rules = await collection('commercialRules');
    assert.deepEqual(
      (await rules.find({ partnerId: hotelId }, { sort: { version: 1 } }).toArray()).map((rule) => rule.status),
      ['SUPERSEDED', 'ACTIVE'],
    );
  });

  it('switches to percent terms and back: each switch is a new version, the same terms are not', async () => {
    const admin = await signedIn('admin@number160.local');
    const path = `/api/v1/partners/${hotelId}/rule`;
    const percent = await admin.post(path, { pricingModel: 'PERCENT', customerDiscountPercent: '10', commissionPercent: '15' });
    assert.equal(percent.status, 200);
    assert.deepEqual(
      (({ version, pricingModel, customerDiscountAmount, customerDiscountRate, companyCommissionRate }) => ({
        version,
        pricingModel,
        customerDiscountAmount,
        customerDiscountRate,
        companyCommissionRate,
      }))(percent.body.partner.rule),
      { version: 3, pricingModel: 'PERCENT', customerDiscountAmount: null, customerDiscountRate: '0.1000', companyCommissionRate: '0.1500' },
    );
    const same = await admin.post(path, { pricingModel: 'PERCENT', customerDiscountPercent: '10.00', commissionPercent: '15' });
    assert.equal(same.body.partner.rule.version, 3);

    const invalid = await admin.post(path, { pricingModel: 'PERCENT', customerDiscountPercent: '3', commissionPercent: '15' });
    assert.equal(invalid.status, 422);
    assert.deepEqual(invalid.body.error.details.reasons, ['CUSTOMER_DISCOUNT_BELOW_MINIMUM']);
    assert.equal((await admin.post(path, { pricingModel: 'VAT', customerDiscountAmount: '1', commissionAmount: '1' })).status, 422);

    const fixed = await admin.post(path, { pricingModel: 'FIXED_AMOUNT', customerDiscountAmount: '120000', commissionAmount: '150000' });
    assert.equal(fixed.body.partner.rule.version, 4);
    assert.equal(fixed.body.partner.rule.pricingModel, 'FIXED_AMOUNT');

    const audit = await (await collection('auditEvents')).find({ eventType: 'COMMERCIAL_RULE_CHANGED', entityId: hotelId }, { sort: { createdAt: 1 } }).toArray();
    const [toPercent, toFixed] = audit.slice(-2);
    assert.deepEqual(toPercent.after, { version: 3, pricingModel: 'PERCENT', customerDiscountRate: '0.1000', commissionRate: '0.1500' });
    assert.deepEqual(toFixed.before, { version: 3, pricingModel: 'PERCENT', customerDiscountRate: '0.1000', commissionRate: '0.1500' });
    assert.equal(toFixed.after.pricingModel, 'FIXED_AMOUNT');
  });

  it('creates a partner with percent terms', async () => {
    const admin = await signedIn('admin@number160.local');
    const res = await admin.post('/api/v1/partners', {
      ...HOTEL,
      name: 'Khách sạn Phần Trăm',
      rule: { pricingModel: 'PERCENT', customerDiscountPercent: '7', commissionPercent: '8' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.partner.rule.pricingModel, 'PERCENT');
    assert.equal(res.body.partner.rule.customerDiscountRate, '0.0700');
    assert.equal(res.body.partner.rule.companyCommissionRate, '0.0800');
  });

  it('independent individual: the account invited is a Referrer who lands on MyConnect', async () => {
    const admin = await signedIn('admin@number160.local');
    const res = await admin.post('/api/v1/partners', {
      name: 'Anh Tuấn',
      relationshipKind: 'INDEPENDENT_INDIVIDUAL',
      partnerType: 'DRIVER',
      rule: { customerDiscountAmount: '50000', commissionAmount: '80000' },
      account: { email: 'Tuan@driver.local', displayName: 'Anh Tuấn', preferredLanguage: 'vi' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.partner.rule.commissionAmount, '80000.0000');
    assert.equal(res.body.partner.accounts[0].role, 'REFERRER');
    const accept = await new Agent(server.baseUrl).post('/api/v1/auth/invitations/accept', {
      token: tokenFromLink(res.body.invitation.inviteUrl),
      password: NEW_PASSWORD,
    });
    assert.equal(accept.status, 200);
    const referrer = new Agent(server.baseUrl);
    const login = await referrer.login('tuan@driver.local', NEW_PASSWORD);
    assert.equal(login.status, 200);
    assert.equal(login.body.activeRole.role, 'REFERRER');
    assert.equal(login.body.landing, '/my');
  });

  it('partner accounts do not show up in the merchant team list', async () => {
    const admin = await signedIn('admin@number160.local');
    const team = await admin.get('/api/v1/users');
    assert.ok(!team.body.users.some((/** @type {any} */ user) => user.email === 'tuan@driver.local'));
  });

  it('company partner account is a Partner admin', async () => {
    const admin = await signedIn('admin@number160.local');
    const res = await admin.post(`/api/v1/partners/${hotelId}/invitations`, { email: 'mai@hoasen.local', displayName: 'Chị Mai' });
    assert.equal(res.status, 201);
    const list = await admin.get('/api/v1/partners');
    const hotel = list.body.partners.find((/** @type {any} */ p) => p.id === hotelId);
    assert.deepEqual(hotel.accounts.map((/** @type {any} */ a) => [a.email, a.role, a.status]), [['mai@hoasen.local', 'PARTNER_ADMIN', 'INVITED']]);
  });

  it('pause and resume; ending needs a reason, ends the partner roles and is final', async () => {
    const admin = await signedIn('admin@number160.local');
    const tuan = (await admin.get('/api/v1/partners')).body.partners.find((/** @type {any} */ p) => p.name === 'Anh Tuấn');
    const referrer = new Agent(server.baseUrl);
    await referrer.login('tuan@driver.local', NEW_PASSWORD);

    assert.equal((await admin.post(`/api/v1/partners/${tuan.id}/status`, { status: 'PAUSED' })).body.partner.status, 'PAUSED');
    assert.equal((await referrer.get('/api/v1/auth/me')).status, 200);
    assert.equal((await admin.post(`/api/v1/partners/${tuan.id}/status`, { status: 'ACTIVE' })).body.partner.status, 'ACTIVE');

    assert.equal((await admin.post(`/api/v1/partners/${tuan.id}/status`, { status: 'ENDED' })).status, 422);
    const ended = await admin.post(`/api/v1/partners/${tuan.id}/status`, { status: 'ENDED', reason: 'Stopped driving' });
    assert.equal(ended.body.partner.status, 'ENDED');
    assert.equal(ended.body.partner.accounts.length, 0);
    assert.equal((await referrer.get('/api/v1/auth/me')).status, 401);

    const again = await admin.post(`/api/v1/partners/${tuan.id}/status`, { status: 'ACTIVE' });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'PARTNER_ENDED');
    assert.equal((await admin.post(`/api/v1/partners/${tuan.id}/rule`, HOTEL.rule)).status, 409);
  });

  it('another merchant neither sees nor changes these partners', async () => {
    const other = await signedIn('admin@other.local');
    assert.equal((await other.get('/api/v1/partners')).body.partners.length, 0);
    assert.equal((await other.post(`/api/v1/partners/${hotelId}/status`, { status: 'PAUSED' })).status, 404);
    assert.equal((await other.post(`/api/v1/partners/${hotelId}/rule`, HOTEL.rule)).status, 404);
  });

  it('Manager lists but cannot manage; Staff cannot list; Platform admin sees every merchant', async () => {
    const manager = await signedIn('manager@number160.local');
    assert.equal((await manager.get('/api/v1/partners')).status, 200);
    assert.equal((await manager.post('/api/v1/partners', { ...HOTEL, name: 'X' })).status, 403);
    assert.equal((await manager.post(`/api/v1/partners/${hotelId}/rule`, HOTEL.rule)).status, 403);
    const staff = await signedIn('staff@number160.local');
    assert.equal((await staff.get('/api/v1/partners')).status, 403);
    const platform = await signedIn('platform@connect.local');
    const all = await platform.get('/api/v1/partners');
    assert.equal(all.status, 200);
    assert.ok(all.body.partners.some((/** @type {any} */ p) => p.id === hotelId && p.merchantName === 'Number160'));
    assert.equal((await platform.post('/api/v1/partners', HOTEL)).status, 403);
  });
});
