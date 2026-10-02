import { passwordPolicyErrors } from '#domain';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import { hashPassword } from '../src/auth/password.js';
import { collection } from '../src/db/mongo.js';
import { seedPartners } from '../src/db/seed-local.js';
import { useTestTransport } from '../src/notify/mail.js';
import { Agent, PASSWORD, resetDatabase, startServer } from './helpers.js';

const NEW_PASSWORD = 'Partner#Own2026';
const DAY_MS = 24 * 60 * 60 * 1000;

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server;

before(async () => {
  await resetDatabase();
  await seedPartners(PASSWORD);
  server = await startServer();
});

afterEach(() => useTestTransport(undefined));

after(async () => {
  await server?.close();
});

const agent = () => new Agent(server.baseUrl);
let counter = 0;

/** A valid partner application with a unique email; `overrides` replace fields. */
function application(overrides = {}) {
  counter += 1;
  return {
    relationshipKind: 'COMPANY',
    partnerType: 'HOTEL',
    name: `Hotel Sen ${counter}`,
    contactName: `Front desk ${counter}`,
    phone: '0903 111 222',
    email: `desk${counter}@hotelsen.local`,
    preferredLanguage: 'vi',
    note: 'District 1, 40 rooms',
    acceptTerms: true,
    website: '',
    ...overrides,
  };
}

/** @param {Record<string, unknown>} body */
const submit = (body) => agent().post('/api/v1/partner-applications', body);

/** @param {'platform' | 'admin' | 'manager' | 'staff' | 'referrer' | 'partner'} who */
async function signedIn(who) {
  const emails = {
    platform: 'platform@connect.local',
    admin: 'admin@number160.local',
    manager: 'manager@number160.local',
    staff: 'staff@number160.local',
    referrer: 'referrer@number160.local',
    partner: 'partner@number160.local',
  };
  const client = agent();
  const res = await client.login(emails[who]);
  assert.equal(res.status, 200, `sign-in ${who}`);
  return client;
}

/** Submits an application and returns its stored id. */
async function pending(overrides = {}) {
  const body = application(overrides);
  assert.equal((await submit(body)).status, 202);
  const stored = await (await collection('partnerApplications')).findOne({ email: body.email, status: 'PENDING' });
  return { body, id: /** @type {string} */ (stored?._id) };
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

describe('partner application: submit (public)', () => {
  it('stores a valid application as PENDING', async () => {
    const body = application();
    const res = await submit(body);
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { ok: true, status: 'PENDING' });

    const stored = await (await collection('partnerApplications')).findOne({ email: body.email });
    assert.equal(stored?.status, 'PENDING');
    assert.equal(stored?.relationshipKind, 'COMPANY');
    assert.equal(stored?.partnerType, 'HOTEL');
    assert.equal(stored?.name, body.name);
    assert.equal(stored?.contactName, body.contactName);
    assert.equal(stored?.phone, '0903 111 222');
    assert.equal(stored?.preferredLanguage, 'vi');
    assert.equal(stored?.note, 'District 1, 40 rooms');
    assert.ok(stored?.termsAcceptedAt instanceof Date);
    const events = await collection('auditEvents');
    assert.equal(await events.countDocuments({ eventType: 'PARTNER_APPLICATION_SUBMITTED', entityId: stored?._id }), 1);
  });

  it('accepts an individual without a contact person and lower-cases the email', async () => {
    const body = application({ relationshipKind: 'INDEPENDENT_INDIVIDUAL', partnerType: 'TOUR_GUIDE', name: 'Minh Guide', contactName: '', email: `Minh${counter}@Guide.local` });
    assert.equal((await submit(body)).status, 202);
    const stored = await (await collection('partnerApplications')).findOne({ email: body.email.toLowerCase() });
    assert.equal(stored?.contactName, null);
    assert.equal(stored?.partnerType, 'TOUR_GUIDE');
  });

  it('refuses missing and too long fields with 422', async () => {
    const cases = [
      [application({ name: '' }), 'name'],
      [application({ name: '   ' }), 'name'],
      [application({ name: 'x'.repeat(121) }), 'name'],
      [application({ email: '' }), 'email'],
      [application({ email: 'not-an-email' }), 'email'],
      [application({ relationshipKind: undefined }), 'relationshipKind'],
      [application({ relationshipKind: 'FRIEND' }), 'relationshipKind'],
      [application({ partnerType: undefined }), 'partnerType'],
      [application({ partnerType: 'SPA' }), 'partnerType'],
      [application({ contactName: '' }), 'contactName'],
      [application({ contactName: 'c'.repeat(121) }), 'contactName'],
      [application({ phone: '1'.repeat(33) }), 'phone'],
      [application({ note: 'n'.repeat(501) }), 'note'],
      [application({ preferredLanguage: 'fr' }), 'preferredLanguage'],
    ];
    for (const [body, field] of cases) {
      const res = await submit(/** @type {Record<string, unknown>} */ (body));
      assert.equal(res.status, 422, String(field));
      assert.equal(res.body.error.code, 'VALIDATION', String(field));
      assert.equal(res.body.error.details.field, field);
    }
  });

  it('requires the terms to be accepted', async () => {
    for (const acceptTerms of [false, undefined, 'yes']) {
      const res = await submit(application({ acceptTerms }));
      assert.equal(res.status, 422);
      assert.equal(res.body.error.code, 'TERMS_NOT_ACCEPTED');
    }
  });

  it('answers a filled honeypot like a success but stores nothing', async () => {
    const body = application({ website: 'https://spam.example' });
    const res = await submit(body);
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { ok: true, status: 'PENDING' });
    assert.equal(await (await collection('partnerApplications')).countDocuments({ email: body.email }), 0);
    assert.equal(await (await collection('auditEvents')).countDocuments({ 'after.email': body.email }), 0);
  });

  it('refuses an email with an account or a pending merchant or partner application (409)', async () => {
    const account = await submit(application({ email: 'Staff@number160.local' }));
    assert.equal(account.status, 409);
    assert.equal(account.body.error.code, 'EMAIL_HAS_ACCOUNT');

    const { body: first } = await pending();
    const samePartner = await submit(application({ email: first.email }));
    assert.equal(samePartner.status, 409);
    assert.equal(samePartner.body.error.code, 'APPLICATION_PENDING');

    const merchantEmail = `owner${counter}@spa.local`;
    const merchant = await agent().post('/api/v1/merchant-applications', {
      name: `Spa Partner Check ${counter}`,
      admin: { displayName: 'Owner', email: merchantEmail, preferredLanguage: 'en' },
      acceptTerms: true,
    });
    assert.equal(merchant.status, 202);
    const sameMerchant = await submit(application({ email: merchantEmail }));
    assert.equal(sameMerchant.status, 409);
    assert.equal(sameMerchant.body.error.code, 'APPLICATION_PENDING');

    const merchantAfterPartner = await agent().post('/api/v1/merchant-applications', {
      name: `Spa Partner Check B ${counter}`,
      admin: { displayName: 'Desk', email: first.email, preferredLanguage: 'en' },
      acceptTerms: true,
    });
    assert.equal(merchantAfterPartner.status, 409);
    assert.equal(merchantAfterPartner.body.error.code, 'APPLICATION_PENDING');
  });

  it('limits submissions per IP and per email (429), shared with merchant applications', async () => {
    const sameIp = agent();
    for (let i = 0; i < 4; i++) assert.notEqual((await sameIp.post('/api/v1/partner-applications', application({ name: '' }))).status, 429);
    assert.notEqual((await sameIp.post('/api/v1/merchant-applications', { name: '' })).status, 429);
    const limited = await sameIp.post('/api/v1/partner-applications', application());
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'RATE_LIMITED');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);

    const email = `busy${counter}@hotelsen.local`;
    assert.equal((await submit(application({ email }))).status, 202);
    assert.equal((await submit(application({ email }))).status, 409);
    assert.equal((await submit(application({ email }))).status, 409);
    assert.equal((await submit(application({ email }))).status, 429);
  });
});

describe('@permission partner application review', () => {
  it('only the Platform admin lists, approves and rejects', async () => {
    const { id } = await pending();
    for (const who of /** @type {const} */ (['admin', 'manager', 'staff', 'referrer', 'partner'])) {
      const client = await signedIn(who);
      assert.equal((await client.get('/api/v1/partner-applications')).status, 403, who);
      assert.equal((await client.post(`/api/v1/partner-applications/${id}/approve`, {})).status, 403, who);
      assert.equal((await client.post(`/api/v1/partner-applications/${id}/reject`, { reason: 'No' })).status, 403, who);
    }
    const anonymous = agent();
    assert.equal((await anonymous.get('/api/v1/partner-applications')).status, 401);
    assert.equal((await anonymous.post(`/api/v1/partner-applications/${id}/approve`, {})).status, 401);
    assert.equal((await anonymous.post(`/api/v1/partner-applications/${id}/reject`, { reason: 'No' })).status, 401);

    const platform = await signedIn('platform');
    const list = await platform.get('/api/v1/partner-applications?status=PENDING');
    assert.equal(list.status, 200);
    const found = list.body.applications.find((/** @type {any} */ a) => a.id === id);
    assert.equal(found.status, 'PENDING');
    assert.equal(found.relationshipKind, 'COMPANY');
    assert.equal(found.partnerType, 'HOTEL');
    assert.equal(found.preferredLanguage, 'vi');
    assert.equal(found.note, 'District 1, 40 rooms');
    assert.equal((await platform.get('/api/v1/partner-applications?status=DONE')).status, 422);
  });

  it('the partner profile is only for partner sessions', async () => {
    for (const who of /** @type {const} */ (['admin', 'staff', 'platform'])) {
      const client = await signedIn(who);
      assert.equal((await client.get('/api/v1/partner-profile')).status, 403, who);
      assert.equal((await client.post('/api/v1/partner-profile', { preferredLanguage: 'en' })).status, 403, who);
    }
    assert.equal((await agent().get('/api/v1/partner-profile')).status, 401);
    const partner = await signedIn('partner');
    const none = await partner.get('/api/v1/partner-profile');
    assert.equal(none.status, 404);
    assert.equal(none.body.error.code, 'PARTNER_PROFILE_NOT_FOUND');
  });
});

describe('partner application: approve and first sign-in', () => {
  /** @type {{ body: any, id: string }} */
  let app;
  /** @type {any} */
  let approved;
  /** @type {Agent} */
  let partner;
  before(() => {
    partner = agent();
  });

  it('creates an ACTIVE account without roles, a partner profile and a temporary password, once', async () => {
    app = await pending();
    const platform = await signedIn('platform');
    const outbox = capture();
    const res = await platform.post(`/api/v1/partner-applications/${app.id}/approve`, {});
    assert.equal(res.status, 201);
    approved = res.body;
    assert.equal(approved.user.email, app.body.email);
    assert.equal(approved.profile.name, app.body.name);
    assert.equal(approved.profile.relationshipKind, 'COMPANY');
    assert.equal(approved.profile.partnerType, 'HOTEL');
    assert.equal(approved.profile.contactName, app.body.contactName);
    assert.equal(approved.profile.status, 'ACTIVE');
    assert.equal(approved.emailSent, true);
    assert.deepEqual(passwordPolicyErrors(approved.temporaryPassword), []);
    const ttl = new Date(approved.expiresAt).getTime() - Date.now();
    assert.ok(ttl > 7 * DAY_MS - 60_000 && ttl <= 7 * DAY_MS, `expires in ${ttl} ms`);

    const user = await (await collection('users')).findOne({ email: app.body.email });
    assert.equal(user?.status, 'ACTIVE');
    assert.deepEqual(user?.roles, []);
    assert.equal(user?.mustChangePassword, true);
    assert.equal(user?.displayName, app.body.contactName);
    assert.equal(user?.preferredLanguage, 'vi');
    assert.ok(user?.tempPasswordExpiresAt instanceof Date);
    assert.ok(!user?.passwordHash.includes(approved.temporaryPassword));

    const profile = await (await collection('partnerProfiles')).findOne({ userId: user?._id });
    assert.equal(profile?._id, approved.profile.id);
    assert.equal(profile?.applicationId, app.id);
    assert.ok(profile?.approvedBy);
    assert.equal(profile?.note, 'District 1, 40 rooms');

    const stored = await (await collection('partnerApplications')).findOne({ _id: app.id });
    assert.equal(stored?.status, 'APPROVED');
    assert.equal(stored?.userId, user?._id);
    assert.equal(stored?.profileId, profile?._id);

    const events = await collection('auditEvents');
    assert.equal(await events.countDocuments({ eventType: 'PARTNER_APPLICATION_APPROVED', entityId: app.id }), 1);
    assert.equal(await events.countDocuments({ eventType: 'TEMPORARY_PASSWORD_ISSUED', entityId: user?._id }), 1);
    const all = JSON.stringify(await events.find({}).toArray());
    assert.ok(!all.includes(approved.temporaryPassword), 'temporary password in audit');

    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].to, app.body.email);
    assert.equal(outbox[0].subject, 'Tài khoản partner MyConnect của bạn đã sẵn sàng');
    assert.ok(outbox[0].text.includes(approved.temporaryPassword));
    assert.ok(outbox[0].text.includes('/login'));

    const again = await platform.post(`/api/v1/partner-applications/${app.id}/approve`, {});
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'APPLICATION_NOT_PENDING');
    const resubmit = await submit(application({ email: app.body.email }));
    assert.equal(resubmit.body.error.code, 'EMAIL_HAS_ACCOUNT');
  });

  it('signs in without a merchant, must change the password, then reaches the profile', async () => {
    const login = await partner.login(app.body.email, approved.temporaryPassword);
    assert.equal(login.status, 200);
    assert.equal(login.body.mustChangePassword, true);
    assert.equal(login.body.activeRole, null);
    assert.deepEqual(login.body.roles, []);
    assert.equal(login.body.partnerProfile, true);
    assert.equal(login.body.landing, '/partner/welcome');

    const blocked = await partner.get('/api/v1/partner-profile');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'PASSWORD_CHANGE_REQUIRED');

    const change = await partner.post('/api/v1/auth/password/change', { currentPassword: approved.temporaryPassword, newPassword: NEW_PASSWORD });
    assert.equal(change.status, 200);
    assert.equal(change.body.mustChangePassword, false);
    assert.equal(change.body.landing, '/partner/welcome');

    const me = await partner.get('/api/v1/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.partnerProfile, true);
    assert.equal(me.body.landing, '/partner/welcome');

    const profile = await partner.get('/api/v1/partner-profile');
    assert.equal(profile.status, 200);
    assert.equal(profile.body.profile.email, app.body.email);
    assert.equal(profile.body.profile.name, app.body.name);

    for (const path of ['/api/v1/my/partner', '/api/v1/partners', '/api/v1/vouchers', '/api/v1/merchant-applications']) {
      assert.equal((await partner.get(path)).status, 403, path);
    }

    const fresh = agent();
    const second = await fresh.login(app.body.email, NEW_PASSWORD);
    assert.equal(second.status, 200);
    assert.equal(second.body.mustChangePassword, false);
    assert.equal(second.body.landing, '/partner/welcome');
  });

  it('edits the contact details; the language also becomes the account language', async () => {
    const empty = await partner.post('/api/v1/partner-profile', { contactName: '', phone: '', note: '', preferredLanguage: 'en' });
    assert.equal(empty.status, 422);
    assert.equal(empty.body.error.details.field, 'contactName');
    assert.equal((await partner.post('/api/v1/partner-profile', { contactName: 'A', preferredLanguage: 'de' })).status, 422);
    assert.equal((await partner.post('/api/v1/partner-profile', { contactName: 'A', phone: '1'.repeat(33), preferredLanguage: 'en' })).status, 422);

    const res = await partner.post('/api/v1/partner-profile', { contactName: 'Lan Reception', phone: '0909 000 111', note: '45 rooms now', preferredLanguage: 'en' });
    assert.equal(res.status, 200);
    assert.equal(res.body.profile.contactName, 'Lan Reception');
    assert.equal(res.body.profile.phone, '0909 000 111');
    assert.equal(res.body.profile.note, '45 rooms now');
    assert.equal(res.body.profile.preferredLanguage, 'en');
    assert.equal(res.body.profile.name, app.body.name, 'name is not editable');
    const user = await (await collection('users')).findOne({ email: app.body.email });
    assert.equal(user?.preferredLanguage, 'en');
    assert.equal(await (await collection('auditEvents')).countDocuments({ eventType: 'PARTNER_PROFILE_UPDATED', entityId: approved.profile.id }), 1);
  });

  it('refuses an expired temporary password; the Platform admin issues a new one', async () => {
    const { body, id } = await pending({ relationshipKind: 'INDEPENDENT_INDIVIDUAL', partnerType: 'DRIVER', name: 'Tuan Driver', contactName: '', preferredLanguage: 'en' });
    const platform = await signedIn('platform');
    const res = await platform.post(`/api/v1/partner-applications/${id}/approve`, {});
    assert.equal(res.status, 201);
    const users = await collection('users');
    const user = await users.findOne({ email: body.email });
    assert.equal(user?.displayName, 'Tuan Driver');

    await users.updateOne({ _id: user?._id }, { $set: { tempPasswordExpiresAt: new Date(Date.now() - 1000) } });
    const expired = await agent().login(body.email, res.body.temporaryPassword);
    assert.equal(expired.status, 401);
    assert.equal(expired.body.error.code, 'TEMP_PASSWORD_EXPIRED');

    const reissued = await platform.post(`/api/v1/users/${user?._id}/temporary-password`);
    assert.equal(reissued.status, 201);
    assert.equal(reissued.body.admin.email, body.email);
    assert.deepEqual(passwordPolicyErrors(reissued.body.temporaryPassword), []);
    const fresh = await agent().login(body.email, reissued.body.temporaryPassword);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.mustChangePassword, true);
    assert.equal(fresh.body.landing, '/partner/welcome');
  });

  it('an account with neither a role nor a partner profile still cannot sign in', async () => {
    const users = await collection('users');
    const now = new Date();
    const email = `norole${counter}@connect.local`;
    await users.insertOne({
      _id: randomUUID(),
      email,
      displayName: 'No Role',
      status: 'ACTIVE',
      preferredLanguage: 'en',
      passwordHash: await hashPassword(NEW_PASSWORD),
      passwordChangedAt: now,
      roles: [],
      createdAt: now,
      updatedAt: now,
    });
    const res = await agent().login(email, NEW_PASSWORD);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'NO_ACTIVE_ROLE');

    const paused = await pending();
    const platform = await signedIn('platform');
    const approvedPaused = await platform.post(`/api/v1/partner-applications/${paused.id}/approve`, {});
    await (await collection('partnerProfiles')).updateOne({ _id: approvedPaused.body.profile.id }, { $set: { status: 'PAUSED' } });
    const pausedLogin = await agent().login(paused.body.email, approvedPaused.body.temporaryPassword);
    assert.equal(pausedLogin.status, 403);
    assert.equal(pausedLogin.body.error.code, 'NO_ACTIVE_ROLE');
  });
});

describe('partner application: reject', () => {
  it('needs a reason, stores it, and the application cannot be approved afterwards', async () => {
    const { body, id } = await pending({ preferredLanguage: 'en' });
    const platform = await signedIn('platform');
    assert.equal((await platform.post(`/api/v1/partner-applications/${id}/reject`, { reason: '  ' })).status, 422);
    assert.equal((await platform.post(`/api/v1/partner-applications/${id}/reject`, { reason: 'x'.repeat(501) })).status, 422);

    const outbox = capture();
    const res = await platform.post(`/api/v1/partner-applications/${id}/reject`, { reason: 'Outside our area' });
    assert.equal(res.status, 200);
    assert.equal(res.body.application.status, 'REJECTED');
    assert.equal(res.body.application.rejectReason, 'Outside our area');
    assert.equal(res.body.emailSent, true);
    const stored = await (await collection('partnerApplications')).findOne({ _id: id });
    assert.equal(stored?.rejectReason, 'Outside our area');
    assert.ok(stored?.reviewedBy);
    const event = await (await collection('auditEvents')).findOne({ eventType: 'PARTNER_APPLICATION_REJECTED', entityId: id });
    assert.equal(event?.reason, 'Outside our area');
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].to, body.email);
    assert.equal(outbox[0].subject, 'Your partner application was not approved');
    assert.ok(outbox[0].text.includes('Outside our area'));
    assert.ok(outbox[0].text.includes('/register?type=partner'));

    for (const action of ['approve', 'reject']) {
      const again = await platform.post(`/api/v1/partner-applications/${id}/${action}`, { reason: 'again' });
      assert.equal(again.status, 409, action);
      assert.equal(again.body.error.code, 'APPLICATION_NOT_PENDING');
    }
    assert.equal(await (await collection('users')).countDocuments({ email: body.email }), 0);
    assert.equal((await platform.post('/api/v1/partner-applications/00000000-0000-4000-8000-000000000000/approve', {})).status, 404);

    const rejected = await platform.get('/api/v1/partner-applications?status=REJECTED');
    assert.ok(rejected.body.applications.some((/** @type {any} */ a) => a.id === id && a.rejectReason === 'Outside our area'));
    assert.equal((await submit(application({ email: body.email }))).status, 202, 'may apply again after a rejection');
  });
});

describe('partner application: emails', () => {
  it('tells the applicant and every Platform admin, each in their language', async () => {
    const outbox = capture();
    const body = application({ preferredLanguage: 'en', partnerType: 'RESTAURANT' });
    assert.equal((await submit(body)).status, 202);
    const toApplicant = outbox.filter((mail) => mail.to === body.email);
    assert.equal(toApplicant.length, 1);
    assert.equal(toApplicant[0].subject, 'We received your partner application');
    assert.ok(toApplicant[0].text.includes(`Hello ${body.contactName},`));

    const toAdmins = outbox.filter((mail) => mail.to !== body.email);
    assert.ok(toAdmins.some((mail) => mail.to === 'platform@connect.local'));
    for (const mail of toAdmins) {
      assert.match(mail.subject, /^(New partner application|Đơn đăng ký partner mới): /);
      assert.ok(mail.text.includes('/console/merchants'));
    }
    const english = toAdmins.find((mail) => mail.subject.startsWith('New partner application'));
    assert.ok(english?.text.includes('Restaurant · Company'));

    const vi = capture();
    const viBody = application({ preferredLanguage: 'vi' });
    assert.equal((await submit(viBody)).status, 202);
    assert.equal(vi.find((mail) => mail.to === viBody.email)?.subject, 'Chúng tôi đã nhận đơn đăng ký partner của bạn');
  });
});
