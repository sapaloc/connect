import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { collection, getDb } from '../src/db/mongo.js';
import { setup } from '../src/db/setup.js';
import { SEED_SECOND_MERCHANT, SEED_TENANT, seedPartners } from '../src/db/seed-local.js';
import { useTestTransport } from '../src/notify/mail.js';
import { Agent, PASSWORD, resetDatabase, startServer } from './helpers.js';

const OWN_PASSWORD = 'Partner#Free2026';

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server;
/** @type {string} */
let number160;
/** @type {string} */
let restaurant;

before(async () => {
  await resetDatabase();
  await seedPartners(PASSWORD);
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

/** @param {string} email @param {string} [password] */
async function signedIn(email, password) {
  const client = agent();
  const res = await client.login(email, password);
  assert.equal(res.status, 200, `sign-in ${email}`);
  return client;
}

function capture() {
  /** @type {{ to: string, subject: string, text: string }[]} */
  const outbox = [];
  useTestTransport({
    async sendMail(message) {
      outbox.push(message);
      return { messageId: `test-${outbox.length}` };
    },
  });
  return outbox;
}

/** @param {string} email */
async function userByEmail(email) {
  return (await collection('users')).findOne({ email });
}

/** @param {string} userId */
async function profileOf(userId) {
  return (await collection('partnerProfiles')).findOne({ userId });
}

let counter = 0;

/** Add-partner form of the merchant console, with a MyConnect account. */
function addPartnerBody(email, overrides = {}) {
  counter += 1;
  return {
    name: `Merchant Name ${counter}`,
    relationshipKind: 'COMPANY',
    partnerType: 'HOTEL',
    contactName: `Front desk ${counter}`,
    contactPhone: '0903 111 222',
    contactEmail: null,
    rule: { pricingModel: 'FIXED_AMOUNT', customerDiscountAmount: '60000', commissionAmount: '90000' },
    account: { email, displayName: `Account ${counter}`, preferredLanguage: 'en' },
    ...overrides,
  };
}

/** A partner approved from the sign-in page: a profile, no merchant yet, signed in with its own password. */
async function freePartner() {
  counter += 1;
  const body = {
    relationshipKind: 'INDEPENDENT_INDIVIDUAL',
    partnerType: 'TOUR_GUIDE',
    name: `Free Guide ${counter}`,
    contactName: '',
    phone: '0903 777 888',
    email: `free${counter}@partners.local`,
    preferredLanguage: 'vi',
    acceptTerms: true,
  };
  assert.equal((await agent().post('/api/v1/partner-applications', body)).status, 202);
  const stored = await (await collection('partnerApplications')).findOne({ email: body.email, status: 'PENDING' });
  const platform = await signedIn('platform@connect.local');
  const approved = await platform.post(`/api/v1/partner-applications/${stored?._id}/approve`, {});
  assert.equal(approved.status, 201);
  const client = agent();
  assert.equal((await client.login(body.email, approved.body.temporaryPassword)).status, 200);
  assert.equal((await client.post('/api/v1/auth/password/change', { currentPassword: approved.body.temporaryPassword, newPassword: OWN_PASSWORD })).status, 200);
  const user = await userByEmail(body.email);
  return { client, body, userId: /** @type {string} */ (user?._id) };
}

describe('db:setup backfills partner profiles', () => {
  it('gives every partner account without a profile one from its earliest partner record, once, and never changes existing profiles', async () => {
    const partners = await collection('partners');
    const profiles = await collection('partnerProfiles');
    const partner = await userByEmail('partner@number160.local');
    const referrer = await userByEmail('referrer@number160.local');
    const driver = await userByEmail('taixe.demo@example.com');
    assert.equal(await profiles.countDocuments({}), 0);

    // partner@ works with both merchants: the restaurant's record is made the older one.
    const older = new Date('2026-01-02T03:04:05Z');
    await partners.updateOne({ tenantId: restaurant, contactEmail: 'partner@number160.local' }, { $set: { createdAt: older, contactName: 'Restaurant desk' } });
    const ownCreated = new Date('2026-02-01T00:00:00Z');
    await profiles.insertOne({
      _id: '00000000-0000-4000-8000-000000000092',
      userId: referrer?._id,
      relationshipKind: 'INDEPENDENT_INDIVIDUAL',
      partnerType: 'TOUR_GUIDE',
      name: 'My own guide name',
      contactName: null,
      phone: '0909 000 000',
      email: 'referrer@number160.local',
      preferredLanguage: 'vi',
      note: 'Edited by the partner',
      status: 'PAUSED',
      applicationId: null,
      approvedBy: null,
      createdAt: ownCreated,
      updatedAt: ownCreated,
    });
    const ownBefore = await profileOf(referrer?._id);

    const first = await setup(await getDb());
    assert.equal(first.partnerProfilesBackfilled, 2);

    const fromRestaurant = await profileOf(partner?._id);
    assert.equal(fromRestaurant?.status, 'ACTIVE');
    assert.equal(fromRestaurant?.name, 'Khách sạn Demo');
    assert.equal(fromRestaurant?.relationshipKind, 'COMPANY');
    assert.equal(fromRestaurant?.partnerType, 'HOTEL');
    assert.equal(fromRestaurant?.contactName, 'Restaurant desk');
    assert.equal(fromRestaurant?.email, 'partner@number160.local');
    assert.equal(fromRestaurant?.preferredLanguage, partner?.preferredLanguage === 'vi' ? 'vi' : 'en');
    const driverProfile = await profileOf(driver?._id);
    assert.equal(driverProfile?.name, 'Tài xế Demo');
    assert.equal(driverProfile?.relationshipKind, 'INDEPENDENT_INDIVIDUAL');
    assert.equal(driverProfile?.partnerType, 'DRIVER');
    assert.deepEqual(await profileOf(referrer?._id), ownBefore);
    assert.equal(await profiles.countDocuments({ userId: { $in: [partner?._id, referrer?._id, driver?._id] } }), 3);

    const again = await setup(await getDb());
    assert.equal(again.partnerProfilesBackfilled, 0);
    assert.equal(await profiles.countDocuments({}), 3);
    assert.deepEqual(await profileOf(partner?._id), fromRestaurant);
    assert.deepEqual(await profileOf(referrer?._id), ownBefore);
    // The paused profile is the partner's own; it stays paused.
    await profiles.updateOne({ userId: referrer?._id }, { $set: { status: 'ACTIVE' } });
  });
});

describe('merchant adds a partner whose email already has an account', () => {
  it('attaches the partner of another merchant to the same account: no new user, no password, profile untouched, email', async () => {
    const before = await userByEmail('referrer@number160.local');
    const profileBefore = await profileOf(before?._id);
    const users = await collection('users');
    const invitations = await collection('invitations');
    const usersBefore = await users.countDocuments({});
    const linksBefore = await invitations.countDocuments({ userId: before?._id });

    const admin = await signedIn('admin@nhahang.local');
    const outbox = capture();
    const body = addPartnerBody('referrer@number160.local', { name: 'Guide at the restaurant' });
    const res = await admin.post('/api/v1/partners', body);
    assert.equal(res.status, 201);
    assert.equal(res.body.invitation.status, 'ACTIVE');
    assert.equal(res.body.invitation.userId, before?._id);
    assert.equal(res.body.invitation.inviteUrl, null);
    assert.equal(res.body.emailSent, true);

    const after = await userByEmail('referrer@number160.local');
    assert.equal(await users.countDocuments({}), usersBefore);
    assert.equal(after?.passwordHash, before?.passwordHash);
    assert.equal(after?.mustChangePassword, before?.mustChangePassword);
    assert.equal(await invitations.countDocuments({ userId: before?._id }), linksBefore);
    const added = after?.roles.find((/** @type {any} */ role) => role.partnerRelationshipId === res.body.partner.id);
    assert.equal(added?.role, 'PARTNER_ADMIN');
    assert.equal(added?.tenantId, restaurant);
    assert.equal(after?.roles.filter((/** @type {any} */ role) => role.status === 'ACTIVE').length, 2);
    assert.deepEqual(await profileOf(before?._id), profileBefore);
    // The restaurant keeps its own name for this partner.
    assert.equal(res.body.partner.name, 'Guide at the restaurant');
    assert.notEqual(profileBefore?.name, 'Guide at the restaurant');

    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].to, 'referrer@number160.local');
    assert.equal(outbox[0].subject, 'Nhà hàng Demo added you as a partner');
    assert.match(outbox[0].text, /Guide at the restaurant/);
    assert.match(outbox[0].text, /usual email and password/);
    assert.doesNotMatch(outbox[0].text, /password:/i);

    const audits = await collection('auditEvents');
    assert.equal(await audits.countDocuments({ eventType: 'ROLE_GRANTED', entityId: before?._id, tenantId: restaurant }), 1);

    const login = await signedIn('referrer@number160.local');
    const me = await login.get('/api/v1/auth/me');
    assert.equal(me.body.roles.length, 2);
    assert.equal(me.body.activeRole, null);
    assert.equal(me.body.needsRoleSelection, true);
  });

  it('attaches a free partner (profile only) and its open session switches to the new role without signing in again', async () => {
    const free = await freePartner();
    const profileBefore = await profileOf(free.userId);
    const before = await free.client.get('/api/v1/auth/me');
    assert.equal(before.body.activeRole, null);
    assert.equal(before.body.landing, '/partner/welcome');
    const oldCookie = free.client.cookie;

    const admin = await signedIn('admin@number160.local');
    const outbox = capture();
    const res = await admin.post('/api/v1/partners', addPartnerBody(free.body.email, { relationshipKind: 'INDEPENDENT_INDIVIDUAL', partnerType: 'TOUR_GUIDE' }));
    assert.equal(res.status, 201);
    assert.equal(res.body.invitation.status, 'ACTIVE');
    assert.equal(res.body.invitation.userId, free.userId);
    assert.deepEqual(await profileOf(free.userId), profileBefore);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].subject, 'Number160 đã thêm bạn làm partner');

    const me = await free.client.get('/api/v1/auth/me');
    assert.equal(me.status, 200);
    assert.ok(me.setCookie, 'a new session cookie');
    assert.notEqual(free.client.cookie, oldCookie);
    assert.equal(me.body.activeRole.role, 'REFERRER');
    assert.equal(me.body.activeRole.tenantId, number160);
    assert.equal(me.body.landing, '/my');
    assert.equal(me.body.needsRoleSelection, false);
    assert.equal((await free.client.get('/api/v1/my/partner')).status, 200);

    const stale = agent();
    stale.cookie = oldCookie;
    assert.equal((await stale.get('/api/v1/auth/me')).status, 401);
    const audits = await collection('auditEvents');
    assert.equal(await audits.countDocuments({ eventType: 'ROLE_SELECTED', actorUserId: free.userId, tenantId: number160 }), 1);

    const again = await free.client.get('/api/v1/auth/me');
    assert.equal(again.setCookie, null);
    assert.equal(again.body.activeRole.role, 'REFERRER');
  });

  it('creates the profile of a new account from the partner record', async () => {
    const admin = await signedIn('admin@number160.local');
    const body = addPartnerBody('brand.new@partners.local', { account: { email: 'brand.new@partners.local', displayName: 'Brand New', preferredLanguage: 'vi' } });
    const res = await admin.post('/api/v1/partners', body);
    assert.equal(res.status, 201);
    assert.equal(res.body.invitation.status, 'INVITED');
    const profile = await profileOf(res.body.invitation.userId);
    assert.equal(profile?.status, 'ACTIVE');
    assert.equal(profile?.name, body.name);
    assert.equal(profile?.contactName, body.contactName);
    assert.equal(profile?.phone, body.contactPhone);
    assert.equal(profile?.email, 'brand.new@partners.local');
    assert.equal(profile?.preferredLanguage, 'vi');
    assert.equal(profile?.relationshipKind, 'COMPANY');
  });

  it('still refuses a merchant team email and an account already partner of this merchant', async () => {
    const admin = await signedIn('admin@number160.local');
    const partners = await collection('partners');
    const before = await partners.countDocuments({ tenantId: number160 });

    const team = await admin.post('/api/v1/partners', addPartnerBody('staff@number160.local'));
    assert.equal(team.status, 409);
    assert.equal(team.body.error.code, 'ROLE_SIDE_CONFLICT');
    const otherTeam = await admin.post('/api/v1/partners', addPartnerBody('admin@nhahang.local'));
    assert.equal(otherTeam.status, 409);
    assert.equal(otherTeam.body.error.code, 'ROLE_SIDE_CONFLICT');

    const same = await admin.post('/api/v1/partners', addPartnerBody('partner@number160.local'));
    assert.equal(same.status, 409);
    assert.equal(same.body.error.code, 'PARTNER_ALREADY_IN_MERCHANT');
    assert.equal(await partners.countDocuments({ tenantId: number160 }), before);
  });
});

describe('a session without a role', () => {
  it('keeps the choice when the account has several roles', async () => {
    const client = await signedIn('partner@number160.local');
    const me = await client.get('/api/v1/auth/me');
    assert.equal(me.setCookie, null);
    assert.equal(me.body.activeRole, null);
    assert.equal(me.body.needsRoleSelection, true);
  });
});
