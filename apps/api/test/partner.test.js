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
  rule: { totalBudgetPercent: '15', customerDiscountPercent: '7' },
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

describe('@money merchant VAT', () => {
  it('a partner cannot be added before the VAT rate is set', async () => {
    const admin = await signedIn('admin@number160.local');
    const res = await admin.post('/api/v1/partners', HOTEL);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'VAT_NOT_SET');
  });

  it('Merchant admin sets VAT as a percent; it is stored as a 4-decimal rate and audited', async () => {
    const admin = await signedIn('admin@number160.local');
    assert.equal((await admin.post('/api/v1/merchant/settings', { vatPercent: '8.5.1' })).status, 422);
    const res = await admin.post('/api/v1/merchant/settings', { vatPercent: '10' });
    assert.equal(res.status, 200);
    assert.equal(res.body.vatRate, '0.1000');
    assert.equal((await admin.get('/api/v1/merchant/settings')).body.vatRate, '0.1000');
    const audit = await collection('auditEvents');
    assert.equal(await audit.countDocuments({ eventType: 'MERCHANT_VAT_CHANGED' }), 1);
  });

  it('Manager can read the VAT rate but not change it', async () => {
    const manager = await signedIn('manager@number160.local');
    assert.equal((await manager.get('/api/v1/merchant/settings')).status, 200);
    assert.equal((await manager.post('/api/v1/merchant/settings', { vatPercent: '8' })).status, 403);
  });
});

describe('@money @permission partners and commercial rules', () => {
  /** @type {string} */
  let hotelId;

  it('Merchant admin creates a company partner; the commission split is derived from the typed percents', async () => {
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
        totalBudgetRate: '0.1500',
        customerDiscountRate: '0.0700',
        companyCommissionRate: '0.0800',
        individualShareRate: '0.0000',
        companyNetCommissionRate: '0.0800',
        individualCommissionRate: null,
      },
    );
    const rules = await collection('commercialRules');
    const stored = await rules.findOne({ partnerId: hotelId });
    assert.equal(stored?.customerDiscountRate._bsontype, 'Decimal128');
  });

  it('refuses a discount below 5% and a discount that leaves no commission', async () => {
    const admin = await signedIn('admin@number160.local');
    const low = await admin.post('/api/v1/partners', { ...HOTEL, name: 'Low', rule: { totalBudgetPercent: '15', customerDiscountPercent: '4' } });
    assert.equal(low.status, 422);
    assert.equal(low.body.error.code, 'COMMERCIAL_RULE_INVALID');
    assert.deepEqual(low.body.error.details.reasons, ['CUSTOMER_DISCOUNT_BELOW_MINIMUM']);
    const none = await admin.post('/api/v1/partners', { ...HOTEL, name: 'None', rule: { totalBudgetPercent: '10', customerDiscountPercent: '10' } });
    assert.deepEqual(none.body.error.details.reasons, ['CUSTOMER_DISCOUNT_NOT_BELOW_TOTAL_BUDGET']);
  });

  it('refuses a duplicate name within the merchant, case-insensitive', async () => {
    const admin = await signedIn('admin@number160.local');
    const res = await admin.post('/api/v1/partners', { ...HOTEL, name: 'KHÁCH SẠN  HOA SEN' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'PARTNER_EXISTS');
  });

  it('changing the rule creates version 2 and supersedes version 1', async () => {
    const admin = await signedIn('admin@number160.local');
    const res = await admin.post(`/api/v1/partners/${hotelId}/rule`, { totalBudgetPercent: '16', customerDiscountPercent: '8' });
    assert.equal(res.status, 200);
    assert.equal(res.body.partner.rule.version, 2);
    assert.equal(res.body.partner.rule.companyCommissionRate, '0.0800');
    const same = await admin.post(`/api/v1/partners/${hotelId}/rule`, { totalBudgetPercent: '16', customerDiscountPercent: '8' });
    assert.equal(same.body.partner.rule.version, 2);
    const rules = await collection('commercialRules');
    assert.deepEqual(
      (await rules.find({ partnerId: hotelId }, { sort: { version: 1 } }).toArray()).map((rule) => rule.status),
      ['SUPERSEDED', 'ACTIVE'],
    );
  });

  it('independent individual: the account invited is a Referrer who lands on MyConnect', async () => {
    const admin = await signedIn('admin@number160.local');
    const res = await admin.post('/api/v1/partners', {
      name: 'Anh Tuấn',
      relationshipKind: 'INDEPENDENT_INDIVIDUAL',
      partnerType: 'DRIVER',
      rule: { totalBudgetPercent: '12', customerDiscountPercent: '5' },
      account: { email: 'Tuan@driver.local', displayName: 'Anh Tuấn', preferredLanguage: 'vi' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.partner.rule.individualCommissionRate, '0.0700');
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
