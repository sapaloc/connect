import { passwordPolicyErrors } from '#domain';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { collection } from '../src/db/mongo.js';
import { seedPartners } from '../src/db/seed-local.js';
import { Agent, PASSWORD, resetDatabase, startServer } from './helpers.js';

const NEW_PASSWORD = 'MyOwn#Pass2026';
const DAY_MS = 24 * 60 * 60 * 1000;

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server;

before(async () => {
  await resetDatabase();
  await seedPartners(PASSWORD);
  server = await startServer();
});

after(async () => {
  await server?.close();
});

const agent = () => new Agent(server.baseUrl);
let counter = 0;

/** A valid application with a unique business and admin email; `overrides` replace top-level fields. */
function application(overrides = {}) {
  counter += 1;
  return {
    name: `Spa Lotus ${counter}`,
    contactPhone: '0901 234 567',
    contactEmail: `hello${counter}@lotus.local`,
    address: '12 Lê Lợi, Quận 1',
    admin: { displayName: `Owner ${counter}`, email: `owner${counter}@lotus.local`, preferredLanguage: 'vi' },
    acceptTerms: true,
    website: '',
    ...overrides,
  };
}

/** @param {Record<string, unknown>} body */
const submit = (body) => agent().post('/api/v1/merchant-applications', body);

/** @param {'platform' | 'admin' | 'manager' | 'staff' | 'referrer'} who */
async function signedIn(who) {
  const emails = {
    platform: 'platform@connect.local',
    admin: 'admin@number160.local',
    manager: 'manager@number160.local',
    staff: 'staff@number160.local',
    referrer: 'referrer@number160.local',
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
  const stored = await (await collection('merchantApplications')).findOne({ 'admin.email': body.admin.email, status: 'PENDING' });
  return { body, id: /** @type {string} */ (stored?._id) };
}

describe('merchant application: submit (public)', () => {
  it('stores a valid application as PENDING and answers without sensitive data', async () => {
    const body = application();
    const res = await submit(body);
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { ok: true, status: 'PENDING' });

    const stored = await (await collection('merchantApplications')).findOne({ 'admin.email': body.admin.email });
    assert.equal(stored?.status, 'PENDING');
    assert.equal(stored?.name, body.name);
    assert.equal(stored?.slug, `spa-lotus-${counter}`);
    assert.equal(stored?.contactPhone, '0901 234 567');
    assert.deepEqual(stored?.admin, { email: body.admin.email, displayName: body.admin.displayName, preferredLanguage: 'vi' });
    assert.ok(stored?.termsAcceptedAt instanceof Date);
    const events = await collection('auditEvents');
    assert.equal(await events.countDocuments({ eventType: 'MERCHANT_APPLICATION_SUBMITTED', entityId: stored?._id }), 1);
  });

  it('refuses missing and too long fields with 422', async () => {
    const cases = [
      application({ name: '' }),
      application({ name: 'x'.repeat(121) }),
      application({ contactPhone: '1'.repeat(33) }),
      application({ address: 'a'.repeat(301) }),
      application({ contactEmail: 'not-an-email' }),
      application({ admin: { displayName: 'Owner', email: 'x@lotus.local' } }),
      application({ admin: { displayName: '', email: 'y@lotus.local', preferredLanguage: 'en' } }),
      application({ admin: { displayName: 'Owner', email: 'bad', preferredLanguage: 'en' } }),
      application({ admin: { displayName: 'Owner', email: 'z@lotus.local', preferredLanguage: 'fr' } }),
      application({ admin: undefined }),
    ];
    for (const body of cases) {
      const res = await submit(body);
      assert.equal(res.status, 422, JSON.stringify(body));
      assert.equal(res.body.error.code, 'VALIDATION');
    }
    const res = await submit(application({ admin: { displayName: 'Owner', email: 'bad', preferredLanguage: 'en' } }));
    assert.equal(res.body.error.details.field, 'admin.email');
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
    assert.equal(await (await collection('merchantApplications')).countDocuments({ 'admin.email': body.admin.email }), 0);
    assert.equal(await (await collection('auditEvents')).countDocuments({ 'after.adminEmail': body.admin.email }), 0);
  });

  it('refuses taken business names, links and emails with 409', async () => {
    const taken = [
      [application({ name: 'Number160' }), 'MERCHANT_EXISTS'],
      [application({ name: 'NUMBER160' }), 'MERCHANT_EXISTS'],
      [application({ admin: { displayName: 'Staff', email: 'Staff@number160.local', preferredLanguage: 'en' } }), 'EMAIL_HAS_ACCOUNT'],
    ];
    for (const [body, code] of taken) {
      const res = await submit(/** @type {Record<string, unknown>} */ (body));
      assert.equal(res.status, 409, String(code));
      assert.equal(res.body.error.code, code);
    }

    const { body: first } = await pending();
    const sameEmail = await submit(application({ admin: first.admin }));
    assert.equal(sameEmail.status, 409);
    assert.equal(sameEmail.body.error.code, 'APPLICATION_PENDING');
    const sameBusiness = await submit(application({ name: first.name }));
    assert.equal(sameBusiness.status, 409);
    assert.equal(sameBusiness.body.error.code, 'APPLICATION_PENDING');
  });

  it('limits submissions per IP and per email (429)', async () => {
    const sameIp = agent();
    for (let i = 0; i < 5; i++) assert.notEqual((await sameIp.post('/api/v1/merchant-applications', application({ name: '' }))).status, 429);
    const limited = await sameIp.post('/api/v1/merchant-applications', application());
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'RATE_LIMITED');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);

    const admin = { displayName: 'Busy', email: `busy${counter}@lotus.local`, preferredLanguage: 'en' };
    assert.equal((await submit(application({ admin }))).status, 202);
    assert.equal((await submit(application({ admin }))).status, 409);
    assert.equal((await submit(application({ admin }))).status, 409);
    assert.equal((await submit(application({ admin }))).status, 429);
  });
});

describe('@permission merchant application review', () => {
  it('only the Platform admin lists, approves and rejects', async () => {
    const { id } = await pending();
    for (const who of /** @type {const} */ (['admin', 'manager', 'staff', 'referrer'])) {
      const client = await signedIn(who);
      assert.equal((await client.get('/api/v1/merchant-applications')).status, 403, who);
      assert.equal((await client.post(`/api/v1/merchant-applications/${id}/approve`, {})).status, 403, who);
      assert.equal((await client.post(`/api/v1/merchant-applications/${id}/reject`, { reason: 'No' })).status, 403, who);
    }
    const anonymous = agent();
    assert.equal((await anonymous.get('/api/v1/merchant-applications')).status, 401);
    assert.equal((await anonymous.post(`/api/v1/merchant-applications/${id}/approve`, {})).status, 401);
    assert.equal((await anonymous.post(`/api/v1/merchant-applications/${id}/reject`, { reason: 'No' })).status, 401);

    const list = await (await signedIn('platform')).get('/api/v1/merchant-applications?status=PENDING');
    assert.equal(list.status, 200);
    const found = list.body.applications.find((/** @type {any} */ a) => a.id === id);
    assert.equal(found.status, 'PENDING');
    assert.equal(found.admin.preferredLanguage, 'vi');
    assert.equal(found.address, '12 Lê Lợi, Quận 1');
  });

  it('only the Platform admin issues a new temporary password', async () => {
    const tenantAdmin = await signedIn('admin');
    const staff = await (await collection('users')).findOne({ email: 'staff@number160.local' });
    assert.equal((await tenantAdmin.post(`/api/v1/users/${staff?._id}/temporary-password`)).status, 403);
    assert.equal((await agent().post(`/api/v1/users/${staff?._id}/temporary-password`)).status, 401);
  });
});

describe('merchant application: approve and first sign-in', () => {
  /** @type {{ body: any, id: string }} */
  let app;
  /** @type {any} */
  let approved;

  it('creates the merchant and an ACTIVE Merchant admin with a temporary password, once', async () => {
    app = await pending();
    const platform = await signedIn('platform');
    const res = await platform.post(`/api/v1/merchant-applications/${app.id}/approve`, { name: `${app.body.name} Q1`, slug: `lotus-q1-${counter}` });
    assert.equal(res.status, 201);
    approved = res.body;
    assert.equal(approved.merchant.name, `${app.body.name} Q1`);
    assert.equal(approved.merchant.slug, `lotus-q1-${counter}`);
    assert.equal(approved.merchant.contactPhone, '0901 234 567');
    assert.equal(approved.admin.email, app.body.admin.email);
    assert.deepEqual(passwordPolicyErrors(approved.temporaryPassword), []);
    const ttl = new Date(approved.expiresAt).getTime() - Date.now();
    assert.ok(ttl > 7 * DAY_MS - 60_000 && ttl <= 7 * DAY_MS, `expires in ${ttl} ms`);

    const user = await (await collection('users')).findOne({ email: app.body.admin.email });
    assert.equal(user?.status, 'ACTIVE');
    assert.equal(user?.mustChangePassword, true);
    assert.equal(user?.preferredLanguage, 'vi');
    assert.ok(user?.tempPasswordExpiresAt instanceof Date);
    assert.ok(!user?.passwordHash.includes(approved.temporaryPassword));
    assert.deepEqual(
      user?.roles.map((/** @type {any} */ r) => [r.role, r.tenantId, r.status]),
      [['TENANT_ADMIN', approved.merchant.id, 'ACTIVE']],
    );

    const stored = await (await collection('merchantApplications')).findOne({ _id: app.id });
    assert.equal(stored?.status, 'APPROVED');
    assert.equal(stored?.tenantId, approved.merchant.id);
    assert.equal(stored?.userId, user?._id);
    assert.ok(stored?.reviewedBy && stored.reviewedAt instanceof Date);

    const events = await collection('auditEvents');
    for (const eventType of ['MERCHANT_CREATED', 'MERCHANT_APPLICATION_APPROVED', 'TEMPORARY_PASSWORD_ISSUED']) {
      assert.equal(await events.countDocuments({ eventType, tenantId: approved.merchant.id }), 1, eventType);
    }
    const all = JSON.stringify(await events.find({}).toArray());
    assert.ok(!all.includes(approved.temporaryPassword), 'temporary password in audit');

    const list = await platform.get('/api/v1/merchants');
    const row = list.body.merchants.find((/** @type {any} */ m) => m.id === approved.merchant.id);
    assert.equal(row.admins, 1);
    assert.deepEqual(row.awaitingFirstSignIn.map((/** @type {any} */ a) => a.email), [app.body.admin.email]);

    const again = await platform.post(`/api/v1/merchant-applications/${app.id}/approve`, {});
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'APPLICATION_NOT_PENDING');
  });

  it('signs in with the temporary password but only allows changing it', async () => {
    const owner = agent();
    const login = await owner.login(app.body.admin.email, approved.temporaryPassword);
    assert.equal(login.status, 200);
    assert.equal(login.body.mustChangePassword, true);
    assert.equal(login.body.activeRole.role, 'TENANT_ADMIN');
    assert.equal(login.body.activeRole.tenantName, approved.merchant.name);

    const me = await owner.get('/api/v1/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.mustChangePassword, true);
    for (const path of ['/api/v1/users', '/api/v1/partners', '/api/v1/merchant/settings', '/api/v1/vouchers']) {
      const res = await owner.get(path);
      assert.equal(res.status, 403, path);
      assert.equal(res.body.error.code, 'PASSWORD_CHANGE_REQUIRED', path);
    }

    const change = (/** @type {string} */ currentPassword, /** @type {string} */ newPassword) =>
      owner.post('/api/v1/auth/password/change', { currentPassword, newPassword });
    assert.equal((await change('Wrong#Pass2026', NEW_PASSWORD)).body.error.code, 'CURRENT_PASSWORD_WRONG');
    assert.equal((await change(approved.temporaryPassword, 'short')).body.error.code, 'PASSWORD_POLICY');
    assert.equal((await change(approved.temporaryPassword, approved.temporaryPassword)).body.error.code, 'PASSWORD_UNCHANGED');
    const changed = await change(approved.temporaryPassword, NEW_PASSWORD);
    assert.equal(changed.status, 200);
    assert.equal(changed.body.mustChangePassword, false);
    assert.equal(changed.body.landing, '/console');

    assert.equal((await owner.get('/api/v1/users')).status, 200);
    assert.equal((await owner.get('/api/v1/auth/me')).body.mustChangePassword, false);
    const user = await (await collection('users')).findOne({ email: app.body.admin.email });
    assert.equal(user?.mustChangePassword, undefined);
    assert.equal(user?.tempPasswordExpiresAt, undefined);
    assert.equal(await (await collection('auditEvents')).countDocuments({ eventType: 'PASSWORD_CHANGED', entityId: user?._id }), 1);

    assert.equal((await agent().login(app.body.admin.email, approved.temporaryPassword)).status, 401);
    assert.equal((await agent().login(app.body.admin.email, NEW_PASSWORD)).body.mustChangePassword, false);

    const platform = await signedIn('platform');
    const row = (await platform.get('/api/v1/merchants')).body.merchants.find((/** @type {any} */ m) => m.id === approved.merchant.id);
    assert.deepEqual(row.awaitingFirstSignIn, []);
    const reissue = await platform.post(`/api/v1/users/${user?._id}/temporary-password`);
    assert.equal(reissue.status, 409);
    assert.equal(reissue.body.error.code, 'TEMP_PASSWORD_NOT_NEEDED');
  });

  it('refuses an expired temporary password; the Platform admin issues a new one', async () => {
    const { body, id } = await pending();
    const platform = await signedIn('platform');
    const res = await platform.post(`/api/v1/merchant-applications/${id}/approve`, {});
    assert.equal(res.status, 201);
    const users = await collection('users');
    const user = await users.findOne({ email: body.admin.email });

    const early = agent();
    assert.equal((await early.login(body.admin.email, res.body.temporaryPassword)).status, 200);

    await users.updateOne({ _id: user?._id }, { $set: { tempPasswordExpiresAt: new Date(Date.now() - 1000) } });
    const expired = await agent().login(body.admin.email, res.body.temporaryPassword);
    assert.equal(expired.status, 401);
    assert.equal(expired.body.error.code, 'TEMP_PASSWORD_EXPIRED');

    const reissued = await platform.post(`/api/v1/users/${user?._id}/temporary-password`);
    assert.equal(reissued.status, 201);
    assert.equal(reissued.body.admin.email, body.admin.email);
    assert.notEqual(reissued.body.temporaryPassword, res.body.temporaryPassword);
    assert.deepEqual(passwordPolicyErrors(reissued.body.temporaryPassword), []);
    assert.ok(new Date(reissued.body.expiresAt).getTime() > Date.now() + 7 * DAY_MS - 60_000);

    assert.equal((await early.get('/api/v1/auth/me')).status, 401, 'old sessions end');
    assert.equal((await agent().login(body.admin.email, res.body.temporaryPassword)).body.error.code, 'INVALID_CREDENTIALS');
    const fresh = await agent().login(body.admin.email, reissued.body.temporaryPassword);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.mustChangePassword, true);
    assert.equal(await (await collection('auditEvents')).countDocuments({ eventType: 'TEMPORARY_PASSWORD_ISSUED', entityId: user?._id }), 2);
  });

  it('refuses to approve when the email got an account meanwhile, and keeps the application', async () => {
    const { body, id } = await pending();
    const platform = await signedIn('platform');
    const number160 = await (await collection('tenants')).findOne({ name: 'Number160' });
    const invited = await platform.post('/api/v1/users/invitations', {
      tenantId: number160?._id,
      email: body.admin.email,
      displayName: 'Invited',
      role: 'TENANT_ADMIN',
    });
    assert.equal(invited.status, 201);
    const res = await platform.post(`/api/v1/merchant-applications/${id}/approve`, {});
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'EMAIL_HAS_ACCOUNT');
    assert.equal((await (await collection('merchantApplications')).findOne({ _id: id }))?.status, 'PENDING');
    assert.equal(await (await collection('tenants')).countDocuments({ name: body.name }), 0);
  });

  it('refuses an invalid link and a link that is taken', async () => {
    const { id } = await pending();
    const platform = await signedIn('platform');
    assert.equal((await platform.post(`/api/v1/merchant-applications/${id}/approve`, { slug: 'Bad Slug!' })).status, 422);
    const taken = await platform.post(`/api/v1/merchant-applications/${id}/approve`, { slug: 'number160' });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error.code, 'MERCHANT_EXISTS');
    assert.equal((await platform.post('/api/v1/merchant-applications/00000000-0000-4000-8000-000000000000/approve', {})).status, 404);
  });
});

describe('merchant application: reject', () => {
  it('needs a reason, stores it, and the application cannot be approved afterwards', async () => {
    const { body, id } = await pending();
    const platform = await signedIn('platform');
    const empty = await platform.post(`/api/v1/merchant-applications/${id}/reject`, { reason: '  ' });
    assert.equal(empty.status, 422);
    assert.equal((await platform.post(`/api/v1/merchant-applications/${id}/reject`, { reason: 'x'.repeat(501) })).status, 422);

    const res = await platform.post(`/api/v1/merchant-applications/${id}/reject`, { reason: 'Not a spa business' });
    assert.equal(res.status, 200);
    assert.equal(res.body.application.status, 'REJECTED');
    assert.equal(res.body.application.rejectReason, 'Not a spa business');
    const stored = await (await collection('merchantApplications')).findOne({ _id: id });
    assert.equal(stored?.rejectReason, 'Not a spa business');
    assert.ok(stored?.reviewedBy);
    const event = await (await collection('auditEvents')).findOne({ eventType: 'MERCHANT_APPLICATION_REJECTED', entityId: id });
    assert.equal(event?.reason, 'Not a spa business');

    for (const action of ['approve', 'reject']) {
      const again = await platform.post(`/api/v1/merchant-applications/${id}/${action}`, { reason: 'again' });
      assert.equal(again.status, 409, action);
      assert.equal(again.body.error.code, 'APPLICATION_NOT_PENDING');
    }
    assert.equal(await (await collection('users')).countDocuments({ email: body.admin.email }), 0);

    const rejected = await platform.get('/api/v1/merchant-applications?status=REJECTED');
    assert.ok(rejected.body.applications.some((/** @type {any} */ a) => a.id === id && a.rejectReason === 'Not a spa business'));
    assert.ok(!(await platform.get('/api/v1/merchant-applications')).body.applications.some((/** @type {any} */ a) => a.id === id));
    assert.equal((await submit({ ...application(), admin: body.admin })).status, 202, 'may apply again after a rejection');
  });
});
