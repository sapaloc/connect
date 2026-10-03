import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { newRoleAssignment, newTenant } from '../src/db/bootstrap.js';
import { collection } from '../src/db/mongo.js';
import { SEED_SECOND_MERCHANT, SEED_TENANT, seedPartnerProfiles, seedPartners } from '../src/db/seed-local.js';
import { useTestTransport } from '../src/notify/mail.js';
import { Agent, PASSWORD, resetDatabase, startServer } from './helpers.js';

const OWN_PASSWORD = 'Partner#Join2026';

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server;
/** @type {string} */
let number160;
/** @type {string} */
let restaurant;

before(async () => {
  await resetDatabase();
  await seedPartners(PASSWORD);
  await seedPartnerProfiles();
  server = await startServer();
  const tenants = await collection('tenants');
  number160 = /** @type {string} */ ((await tenants.findOne({ name: SEED_TENANT }))?._id);
  restaurant = /** @type {string} */ ((await tenants.findOne({ name: SEED_SECOND_MERCHANT.name }))?._id);
});

afterEach(() => useTestTransport(undefined));

after(async () => {
  await server?.close();
});

const agent = () => new Agent(server.baseUrl);

const EMAILS = {
  platform: 'platform@connect.local',
  admin: 'admin@number160.local',
  manager: 'manager@number160.local',
  staff: 'staff@number160.local',
  restaurantAdmin: 'admin@nhahang.local',
  partner: 'partner@number160.local',
  referrer: 'referrer@number160.local',
};

/** @param {keyof typeof EMAILS} who */
async function signedIn(who) {
  const client = agent();
  const res = await client.login(EMAILS[who]);
  assert.equal(res.status, 200, `sign-in ${who}`);
  return client;
}

/** @typedef {{ to: string, subject: string, text: string }} Sent */

/** In-memory transport: records every message, never opens a connection. */
function capture() {
  /** @type {Sent[]} */
  const outbox = [];
  useTestTransport({
    async sendMail(message) {
      outbox.push(message);
      return { messageId: `test-${outbox.length}` };
    },
  });
  return outbox;
}

let counter = 0;

/**
 * A partner approved from the sign-in page (no merchant yet), signed in with its own password.
 * @param {{ relationshipKind?: string, preferredLanguage?: 'en' | 'vi' }} [options]
 */
async function newPartner({ relationshipKind = 'COMPANY', preferredLanguage = 'en' } = {}) {
  counter += 1;
  const company = relationshipKind === 'COMPANY';
  const body = {
    relationshipKind,
    partnerType: company ? 'HOTEL' : 'TOUR_GUIDE',
    name: company ? `Join Hotel ${counter}` : `Join Guide ${counter}`,
    contactName: company ? `Desk ${counter}` : '',
    phone: '0903 222 333',
    email: `join${counter}@partners.local`,
    preferredLanguage,
    note: 'Near the river',
    acceptTerms: true,
  };
  assert.equal((await agent().post('/api/v1/partner-applications', body)).status, 202);
  const stored = await (await collection('partnerApplications')).findOne({ email: body.email, status: 'PENDING' });
  const platform = await signedIn('platform');
  const approved = await platform.post(`/api/v1/partner-applications/${stored?._id}/approve`, {});
  assert.equal(approved.status, 201);
  const client = agent();
  assert.equal((await client.login(body.email, approved.body.temporaryPassword)).status, 200);
  const changed = await client.post('/api/v1/auth/password/change', { currentPassword: approved.body.temporaryPassword, newPassword: OWN_PASSWORD });
  assert.equal(changed.status, 200);
  const user = await (await collection('users')).findOne({ email: body.email });
  return { client, body, profile: approved.body.profile, userId: /** @type {string} */ (user?._id) };
}

/** @param {Agent} admin @param {boolean} on */
async function setAccepting(admin, on) {
  const res = await admin.post('/api/v1/merchant/accept-partners', { acceptsNewPartners: on });
  assert.equal(res.status, 200);
  assert.equal(res.body.acceptsNewPartners, on);
}

/** The add-partner form as the merchant admin sends it when approving. */
function approveBody(name, overrides = {}) {
  return {
    name,
    relationshipKind: 'COMPANY',
    partnerType: 'HOTEL',
    contactName: 'Desk',
    contactPhone: '0903 222 333',
    contactEmail: null,
    rule: { pricingModel: 'FIXED_AMOUNT', customerDiscountAmount: '75000', commissionAmount: '125000' },
    ...overrides,
  };
}

/** @param {Agent} partner @param {string} merchantId @param {string} [message] */
async function requestJoin(partner, merchantId, message) {
  return partner.post('/api/v1/partner-join-requests', { merchantId, ...(message ? { message } : {}) });
}

describe('@permission merchant setting "Accept new partners"', () => {
  it('is off by default; only the Merchant admin changes it, with an audit event', async () => {
    const admin = await signedIn('admin');
    const settings = await admin.get('/api/v1/merchant/settings');
    assert.equal(settings.status, 200);
    assert.equal(settings.body.acceptsNewPartners, false);

    for (const who of /** @type {const} */ (['manager', 'staff', 'platform', 'partner'])) {
      const client = await signedIn(who);
      assert.equal((await client.post('/api/v1/merchant/accept-partners', { acceptsNewPartners: true })).status, 403, who);
    }
    assert.equal((await agent().post('/api/v1/merchant/accept-partners', { acceptsNewPartners: true })).status, 401);
    for (const value of ['yes', 1, null, undefined]) {
      const res = await admin.post('/api/v1/merchant/accept-partners', { acceptsNewPartners: value });
      assert.equal(res.status, 422, String(value));
      assert.equal(res.body.error.details.field, 'acceptsNewPartners');
    }

    await setAccepting(admin, true);
    await setAccepting(admin, true);
    assert.equal((await admin.get('/api/v1/merchant/settings')).body.acceptsNewPartners, true);
    const tenant = await (await collection('tenants')).findOne({ _id: number160 });
    assert.equal(tenant?.acceptsNewPartners, true);
    const events = await (await collection('auditEvents')).find({ eventType: 'MERCHANT_ACCEPTS_PARTNERS_CHANGED', entityId: number160 }).toArray();
    assert.equal(events.length, 1, 'no event when nothing changes');
    assert.deepEqual(events[0].after, { acceptsNewPartners: true });
  });
});

describe('find merchants (partner)', () => {
  it('lists only active merchants that accept new partners; search ignores Vietnamese marks', async () => {
    const { client } = await newPartner();
    const list = await client.get('/api/v1/partner-merchants');
    assert.equal(list.status, 200);
    const ids = list.body.merchants.map((/** @type {any} */ m) => m.id);
    assert.ok(ids.includes(number160));
    assert.ok(!ids.includes(restaurant), 'restaurant has the setting off');
    assert.equal(list.body.maxPending, 10);
    const n160 = list.body.merchants.find((/** @type {any} */ m) => m.id === number160);
    assert.equal(n160.name, SEED_TENANT);
    assert.equal(n160.partner, false);
    assert.equal(n160.request, null);

    const restaurantAdmin = await signedIn('restaurantAdmin');
    await setAccepting(restaurantAdmin, true);
    const search = await client.get(`/api/v1/partner-merchants?q=${encodeURIComponent('nha hang')}`);
    assert.deepEqual(
      search.body.merchants.map((/** @type {any} */ m) => m.id),
      [restaurant],
    );
    await (await collection('tenants')).updateOne({ _id: restaurant }, { $set: { status: 'PAUSED' } });
    assert.ok(!(await client.get('/api/v1/partner-merchants')).body.merchants.some((/** @type {any} */ m) => m.id === restaurant), 'paused merchant hidden');
    await (await collection('tenants')).updateOne({ _id: restaurant }, { $set: { status: 'ACTIVE' } });
    await setAccepting(restaurantAdmin, false);
  });

  it('a partner with merchants sees "already a partner"; merchant-side and signed-out callers are refused', async () => {
    const partner = await signedIn('partner');
    const list = await partner.get('/api/v1/partner-merchants');
    assert.equal(list.status, 200);
    assert.equal(list.body.merchants.find((/** @type {any} */ m) => m.id === number160)?.partner, true);

    for (const who of /** @type {const} */ (['admin', 'manager', 'staff', 'platform'])) {
      const client = await signedIn(who);
      assert.equal((await client.get('/api/v1/partner-merchants')).status, 403, who);
      assert.equal((await requestJoin(client, number160)).status, 403, who);
    }
    assert.equal((await agent().get('/api/v1/partner-merchants')).status, 401);

    const referrer = await signedIn('referrer');
    const referrerUser = await (await collection('users')).findOne({ email: EMAILS.referrer });
    await (await collection('partnerProfiles')).updateOne({ userId: referrerUser?._id }, { $set: { status: 'PAUSED' } });
    const paused = await referrer.get('/api/v1/partner-merchants');
    assert.equal(paused.status, 404);
    assert.equal(paused.body.error.code, 'PARTNER_PROFILE_NOT_FOUND');
    await (await collection('partnerProfiles')).updateOne({ userId: referrerUser?._id }, { $set: { status: 'ACTIVE' } });
  });
});

describe('join request (partner)', () => {
  it('sends a request with a message and emails the Merchant admins; no duplicate while pending', async () => {
    const { client, body, userId } = await newPartner();
    const outbox = capture();
    const res = await requestJoin(client, number160, '  We send 20 guests a week.  ');
    assert.equal(res.status, 201);
    assert.equal(res.body.request.status, 'PENDING');
    assert.equal(res.body.request.message, 'We send 20 guests a week.');
    assert.equal(res.body.request.merchantName, SEED_TENANT);
    assert.equal(res.body.emailSent, true);

    const stored = await (await collection('partnerJoinRequests')).findOne({ _id: res.body.request.id });
    assert.equal(stored?.userId, userId);
    assert.equal(stored?.tenantId, number160);
    const event = await (await collection('auditEvents')).findOne({ eventType: 'PARTNER_JOIN_REQUESTED', entityId: stored?._id });
    assert.equal(event?.tenantId, number160);

    assert.deepEqual(
      outbox.map((mail) => mail.to),
      [EMAILS.admin],
    );
    assert.equal(outbox[0].subject, `New partner request: ${body.name}`);
    assert.ok(outbox[0].text.includes('Hotel · Company'));
    assert.ok(outbox[0].text.includes('We send 20 guests a week.'));
    assert.ok(outbox[0].text.includes('/console/partners'));

    const again = await requestJoin(client, number160);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'JOIN_REQUEST_PENDING');

    const list = await client.get('/api/v1/partner-merchants');
    const n160 = list.body.merchants.find((/** @type {any} */ m) => m.id === number160);
    assert.equal(n160.request.status, 'PENDING');
    assert.equal(list.body.pendingCount, 1);
  });

  it('refuses a merchant that does not accept partners (404), one already joined (409) and bad input (422)', async () => {
    const { client } = await newPartner();
    const closed = await requestJoin(client, restaurant);
    assert.equal(closed.status, 404);
    assert.equal(closed.body.error.code, 'MERCHANT_NOT_FOUND');
    assert.equal((await requestJoin(client, 'not-a-uuid')).status, 404);
    assert.equal((await requestJoin(client, '00000000-0000-4000-8000-000000000000')).status, 404);
    assert.equal((await client.post('/api/v1/partner-join-requests', { merchantId: number160, message: 'm'.repeat(501) })).status, 422);

    const partner = await signedIn('partner');
    const joined = await requestJoin(partner, number160);
    assert.equal(joined.status, 409);
    assert.equal(joined.body.error.code, 'ALREADY_PARTNER');
  });

  it('allows at most 10 pending requests', async () => {
    const { client } = await newPartner();
    const tenants = await collection('tenants');
    /** @type {string[]} */
    const ids = [];
    for (let i = 0; i < 11; i++) {
      const tenant = { ...newTenant({ name: `Limit Spa ${counter}-${i}`, slug: `limit-spa-${counter}-${i}` }), acceptsNewPartners: true };
      await tenants.insertOne(tenant);
      ids.push(tenant._id);
    }
    for (const id of ids.slice(0, 10)) assert.equal((await requestJoin(client, id)).status, 201);
    const limited = await requestJoin(client, ids[10]);
    assert.equal(limited.status, 409);
    assert.equal(limited.body.error.code, 'JOIN_REQUEST_LIMIT');
    assert.equal(limited.body.error.details.max, 10);
    await tenants.updateMany({ _id: { $in: ids } }, { $set: { status: 'PAUSED' } });
  });

  it('cancels its own pending request, then may ask again; other partners cannot cancel it', async () => {
    const { client } = await newPartner();
    const { client: other } = await newPartner();
    const created = await requestJoin(client, number160);
    const id = created.body.request.id;

    const foreign = await other.post(`/api/v1/partner-join-requests/${id}/cancel`, {});
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.error.code, 'JOIN_REQUEST_NOT_FOUND');

    const cancelled = await client.post(`/api/v1/partner-join-requests/${id}/cancel`, {});
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.request.status, 'CANCELLED');
    const twice = await client.post(`/api/v1/partner-join-requests/${id}/cancel`, {});
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error.code, 'JOIN_REQUEST_NOT_PENDING');
    assert.equal(await (await collection('auditEvents')).countDocuments({ eventType: 'PARTNER_JOIN_CANCELLED', entityId: id }), 1);

    const admin = await signedIn('admin');
    const list = await admin.get('/api/v1/merchant/join-requests');
    assert.ok(!list.body.requests.some((/** @type {any} */ r) => r.id === id), 'cancelled request leaves the merchant list');
    assert.equal((await requestJoin(client, number160)).status, 201);
  });

  it('keeps showing a pending request after the merchant stops accepting partners', async () => {
    const { client } = await newPartner();
    const restaurantAdmin = await signedIn('restaurantAdmin');
    await setAccepting(restaurantAdmin, true);
    const created = await requestJoin(client, restaurant);
    assert.equal(created.status, 201);
    await setAccepting(restaurantAdmin, false);
    const list = await client.get('/api/v1/partner-merchants');
    const shown = list.body.merchants.find((/** @type {any} */ m) => m.id === restaurant);
    assert.equal(shown?.request.status, 'PENDING');
    assert.equal(shown?.acceptsNewPartners, false);
    assert.equal((await client.post(`/api/v1/partner-join-requests/${created.body.request.id}/cancel`, {})).status, 200);
    assert.ok(!(await client.get('/api/v1/partner-merchants')).body.merchants.some((/** @type {any} */ m) => m.id === restaurant));
  });
});

describe('@permission join requests (merchant)', () => {
  it('Merchant admin and Manager list their merchant\'s requests with the partner profile; others cannot', async () => {
    const { client, body } = await newPartner();
    const created = await requestJoin(client, number160, 'Hello');
    const id = created.body.request.id;

    for (const who of /** @type {const} */ (['admin', 'manager'])) {
      const list = await (await signedIn(who)).get('/api/v1/merchant/join-requests');
      assert.equal(list.status, 200, who);
      const found = list.body.requests.find((/** @type {any} */ r) => r.id === id);
      assert.equal(found.message, 'Hello');
      assert.equal(found.profile.name, body.name);
      assert.equal(found.profile.relationshipKind, 'COMPANY');
      assert.equal(found.profile.partnerType, 'HOTEL');
      assert.equal(found.profile.contactName, body.contactName);
      assert.equal(found.profile.phone, '0903 222 333');
      assert.equal(found.profile.email, body.email);
      assert.equal(found.profile.note, 'Near the river');
    }
    const restaurantAdmin = await signedIn('restaurantAdmin');
    const other = await restaurantAdmin.get('/api/v1/merchant/join-requests');
    assert.equal(other.status, 200);
    assert.ok(!other.body.requests.some((/** @type {any} */ r) => r.id === id), 'other merchant never sees it');
    for (const who of /** @type {const} */ (['staff', 'platform', 'partner'])) {
      assert.equal((await (await signedIn(who)).get('/api/v1/merchant/join-requests')).status, 403, who);
    }
    assert.equal((await (await signedIn('admin')).get('/api/v1/merchant/join-requests?status=DONE')).status, 422);
  });

  it('only that merchant\'s admin approves or rejects: Manager / Staff / partner 403, other merchant 404', async () => {
    const { client, body } = await newPartner();
    const id = (await requestJoin(client, number160)).body.request.id;
    for (const who of /** @type {const} */ (['manager', 'staff', 'platform', 'partner'])) {
      const caller = await signedIn(who);
      assert.equal((await caller.post(`/api/v1/merchant/join-requests/${id}/approve`, approveBody(body.name))).status, 403, who);
      assert.equal((await caller.post(`/api/v1/merchant/join-requests/${id}/reject`, {})).status, 403, who);
    }
    assert.equal((await client.post(`/api/v1/merchant/join-requests/${id}/approve`, approveBody(body.name))).status, 403, 'no-role partner');
    const restaurantAdmin = await signedIn('restaurantAdmin');
    const foreign = await restaurantAdmin.post(`/api/v1/merchant/join-requests/${id}/approve`, approveBody(body.name));
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.error.code, 'JOIN_REQUEST_NOT_FOUND');
    assert.equal((await restaurantAdmin.post(`/api/v1/merchant/join-requests/${id}/reject`, {})).status, 404);
    assert.equal((await agent().post(`/api/v1/merchant/join-requests/${id}/approve`, approveBody(body.name))).status, 401);
    const stored = await (await collection('partnerJoinRequests')).findOne({ _id: id });
    assert.equal(stored?.status, 'PENDING');
  });
});

describe('@money approve a join request', () => {
  it('creates the partner, its fixed terms and QR, and the partner role on the existing account', async () => {
    const { client, body, userId } = await newPartner({ preferredLanguage: 'vi' });
    const id = (await requestJoin(client, number160)).body.request.id;
    const users = await collection('users');
    const before = await users.findOne({ _id: userId });
    const admin = await signedIn('admin');

    const invalid = await admin.post(`/api/v1/merchant/join-requests/${id}/approve`, approveBody(body.name, { rule: { customerDiscountAmount: '0', commissionAmount: '0' } }));
    assert.equal(invalid.status, 422);
    const taken = await admin.post(`/api/v1/merchant/join-requests/${id}/approve`, approveBody('Khách sạn Demo'));
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error.code, 'PARTNER_EXISTS');
    assert.equal((await (await collection('partnerJoinRequests')).findOne({ _id: id }))?.status, 'PENDING', 'nothing kept after a failed approve');

    const outbox = capture();
    const res = await admin.post(`/api/v1/merchant/join-requests/${id}/approve`, approveBody(body.name));
    assert.equal(res.status, 201);
    assert.equal(res.body.request.status, 'APPROVED');
    assert.equal(res.body.emailSent, true);
    const partner = res.body.partner;
    assert.equal(partner.name, body.name);
    assert.equal(partner.merchantId, number160);
    assert.equal(partner.status, 'ACTIVE');
    assert.equal(partner.rule.pricingModel, 'FIXED_AMOUNT');
    assert.equal(partner.rule.customerDiscountAmount, '75000.0000');
    assert.equal(partner.rule.commissionAmount, '125000.0000');
    assert.ok(partner.qr?.token);
    assert.deepEqual(
      partner.accounts.map((/** @type {any} */ a) => [a.id, a.email, a.role, a.status]),
      [[userId, body.email, 'PARTNER_ADMIN', 'ACTIVE']],
    );

    const rule = await (await collection('commercialRules')).findOne({ partnerId: partner.id, status: 'ACTIVE' });
    assert.equal(rule?.customerDiscountAmount.toString(), '75000.0000');
    assert.equal(rule?.commissionAmount.toString(), '125000.0000');

    assert.equal(await users.countDocuments({ email: body.email }), 1, 'no new account');
    const afterUser = await users.findOne({ _id: userId });
    assert.equal(afterUser?.passwordHash, before?.passwordHash, 'password unchanged');
    const role = afterUser?.roles.find((/** @type {any} */ r) => r.partnerRelationshipId === partner.id);
    assert.equal(role?.role, 'PARTNER_ADMIN');
    assert.equal(role?.tenantId, number160);
    assert.equal(await (await collection('invitations')).countDocuments({ userId }), 0, 'no invitation link');

    const stored = await (await collection('partnerJoinRequests')).findOne({ _id: id });
    assert.equal(stored?.partnerId, partner.id);
    assert.ok(stored?.reviewedBy);
    const events = await collection('auditEvents');
    assert.equal(await events.countDocuments({ eventType: 'PARTNER_JOIN_APPROVED', entityId: id }), 1);
    assert.equal(await events.countDocuments({ eventType: 'PARTNER_CREATED', entityId: partner.id }), 1);
    assert.equal(await events.countDocuments({ eventType: 'ROLE_GRANTED', entityId: userId }), 1);

    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].to, body.email);
    assert.equal(outbox[0].subject, `${SEED_TENANT} đã chấp nhận yêu cầu hợp tác của bạn`);
    assert.ok(outbox[0].text.includes('/login'));
    assert.ok(!/mật khẩu tạm/i.test(outbox[0].text), 'no password in the email');

    const again = await admin.post(`/api/v1/merchant/join-requests/${id}/approve`, approveBody(`${body.name} 2`));
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'JOIN_REQUEST_NOT_PENDING');

    const login = await agent().login(body.email, OWN_PASSWORD);
    assert.equal(login.status, 200);
    assert.equal(login.body.activeRole?.tenantName, SEED_TENANT);
    assert.equal(login.body.landing, '/my');
    assert.equal(login.body.partnerProfile, true);

    const list = await client.get('/api/v1/partner-merchants');
    assert.equal(list.status, 200, 'the no-role session still finds merchants');
    const n160 = list.body.merchants.find((/** @type {any} */ m) => m.id === number160);
    assert.equal(n160.partner, true);
    assert.equal(n160.request.status, 'APPROVED');
    assert.equal((await requestJoin(client, number160)).body.error.code, 'ALREADY_PARTNER');
  });

  it('an individual gets the Referrer role and can use MyConnect for the new merchant', async () => {
    const { client, body } = await newPartner({ relationshipKind: 'INDEPENDENT_INDIVIDUAL' });
    const id = (await requestJoin(client, number160)).body.request.id;
    const admin = await signedIn('admin');
    const res = await admin.post(
      `/api/v1/merchant/join-requests/${id}/approve`,
      approveBody(body.name, { relationshipKind: 'INDEPENDENT_INDIVIDUAL', partnerType: 'TOUR_GUIDE', rule: { pricingModel: 'PERCENT', customerDiscountPercent: '10', commissionPercent: '15' } }),
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.partner.accounts[0].role, 'REFERRER');
    assert.equal(res.body.partner.rule.pricingModel, 'PERCENT');

    const partner = agent();
    assert.equal((await partner.login(body.email, OWN_PASSWORD)).status, 200);
    const my = await partner.get('/api/v1/my/partner');
    assert.equal(my.status, 200);
    assert.equal(my.body.partner.name, body.name);
    assert.equal(my.body.partner.merchantName, SEED_TENANT);
    assert.ok(my.body.qr?.token);
  });

  it('a partner of several merchants gets one more merchant to pick from', async () => {
    const partner = await signedIn('partner');
    const tenants = await collection('tenants');
    const third = { ...newTenant({ name: 'Third Spa', slug: 'third-spa' }), acceptsNewPartners: true };
    await tenants.insertOne(third);
    const users = await collection('users');
    const user = await users.findOne({ email: EMAILS.partner });
    const adminId = (await users.findOne({ email: EMAILS.restaurantAdmin }))?._id;
    await users.updateOne({ _id: adminId }, { $push: { roles: newRoleAssignment({ role: 'TENANT_ADMIN', tenantId: third._id }) } });
    const id = (await requestJoin(partner, third._id)).body.request.id;

    const thirdAdmin = agent();
    const login = await thirdAdmin.login(EMAILS.restaurantAdmin);
    const option = login.body.roles.find((/** @type {any} */ r) => r.tenantId === third._id);
    assert.equal((await thirdAdmin.post('/api/v1/auth/select-role', { roleAssignmentId: option.roleAssignmentId })).status, 200);
    assert.equal((await thirdAdmin.post(`/api/v1/merchant/join-requests/${id}/approve`, approveBody('Khách sạn Demo'))).status, 201);

    const again = await agent().login(EMAILS.partner);
    assert.equal(again.status, 200);
    assert.equal(again.body.needsRoleSelection, true);
    assert.deepEqual(
      again.body.roles.map((/** @type {any} */ r) => r.tenantName).sort(),
      [SEED_SECOND_MERCHANT.name, SEED_TENANT, 'Third Spa'].sort(),
    );
    assert.equal((await users.findOne({ _id: user?._id }))?.passwordHash, user?.passwordHash);
  });
});

describe('reject a join request', () => {
  it('stores an optional reason, emails the partner, and the partner may ask again', async () => {
    const { client, body } = await newPartner();
    const id = (await requestJoin(client, number160)).body.request.id;
    const admin = await signedIn('admin');
    assert.equal((await admin.post(`/api/v1/merchant/join-requests/${id}/reject`, { reason: 'r'.repeat(501) })).status, 422);

    const outbox = capture();
    const res = await admin.post(`/api/v1/merchant/join-requests/${id}/reject`, { reason: 'We work with hotels in District 1 only' });
    assert.equal(res.status, 200);
    assert.equal(res.body.request.status, 'REJECTED');
    assert.equal(res.body.request.rejectReason, 'We work with hotels in District 1 only');
    assert.equal(res.body.emailSent, true);
    const event = await (await collection('auditEvents')).findOne({ eventType: 'PARTNER_JOIN_REJECTED', entityId: id });
    assert.equal(event?.reason, 'We work with hotels in District 1 only');
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].to, body.email);
    assert.equal(outbox[0].subject, `${SEED_TENANT} did not accept your partner request`);
    assert.ok(outbox[0].text.includes('We work with hotels in District 1 only'));
    assert.ok(outbox[0].text.includes('/my/merchants'));

    assert.equal((await admin.post(`/api/v1/merchant/join-requests/${id}/approve`, approveBody(body.name))).body.error.code, 'JOIN_REQUEST_NOT_PENDING');
    const user = await (await collection('users')).findOne({ email: body.email });
    assert.deepEqual(user?.roles, []);

    const list = await client.get('/api/v1/partner-merchants');
    const n160 = list.body.merchants.find((/** @type {any} */ m) => m.id === number160);
    assert.equal(n160.request.status, 'REJECTED');
    assert.equal(n160.request.rejectReason, 'We work with hotels in District 1 only');
    const rejected = await admin.get('/api/v1/merchant/join-requests?status=REJECTED');
    assert.ok(rejected.body.requests.some((/** @type {any} */ r) => r.id === id));

    const second = await requestJoin(client, number160);
    assert.equal(second.status, 201);
    const noReason = capture();
    const plain = await admin.post(`/api/v1/merchant/join-requests/${second.body.request.id}/reject`, {});
    assert.equal(plain.status, 200);
    assert.equal(plain.body.request.rejectReason, null);
    assert.ok(!noReason[0].text.includes('Reason:'));
  });
});
