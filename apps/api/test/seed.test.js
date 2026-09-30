import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { collection } from '../src/db/mongo.js';
import { SEED_PARTNERS, SEED_SECOND_MERCHANT, seedPartners } from '../src/db/seed-local.js';
import { Agent, PASSWORD, resetDatabase, startServer } from './helpers.js';

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server;

before(async () => {
  await resetDatabase();
  server = await startServer();
});

after(async () => {
  await server?.close();
});

describe('seed partner accounts', () => {
  it('adds one partner per kind with its account, fixed-amount rule and QR, and no VAT', async () => {
    const created = await seedPartners(PASSWORD);
    assert.deepEqual(created, [
      `${SEED_SECOND_MERCHANT.admin.email} (${SEED_SECOND_MERCHANT.name})`,
      ...SEED_PARTNERS.map((sample) => `${sample.account.email} (${sample.merchant})`),
    ]);
    assert.equal(await (await collection('users')).countDocuments({ email: 'multi@number160.local' }), 0);

    const tenant = await (await collection('tenants')).findOne({ name: 'Number160' });
    assert.equal(tenant?.vatRate, undefined);

    const partnerAdmin = new Agent(server.baseUrl);
    const login = await partnerAdmin.login('partner@number160.local');
    assert.equal(login.status, 200);
    const spa = login.body.roles.find((/** @type {any} */ r) => r.tenantName === 'Number160');
    await partnerAdmin.post('/api/v1/auth/select-role', { roleAssignmentId: spa.roleAssignmentId });
    const mine = await partnerAdmin.get('/api/v1/my/partner');
    assert.equal(mine.status, 200);
    assert.equal(mine.body.partner.name, 'Khách sạn Demo');
    assert.equal(mine.body.partner.relationshipKind, 'COMPANY');
    assert.equal(mine.body.rule.customerDiscountAmount, '100000.0000');
    assert.equal(mine.body.rule.commissionAmount, '150000.0000');
    assert.match(mine.body.qr.token, /^[A-Za-z0-9_-]{22}$/);

    const referrer = new Agent(server.baseUrl);
    assert.equal((await referrer.login('referrer@number160.local')).status, 200);
    const own = await referrer.get('/api/v1/my/partner');
    assert.equal(own.status, 200);
    assert.equal(own.body.partner.relationshipKind, 'INDEPENDENT_INDIVIDUAL');

    const driver = new Agent(server.baseUrl);
    assert.equal((await driver.login('taixe.demo@example.com')).status, 200);
    const driverOwn = await driver.get('/api/v1/my/partner');
    assert.equal(driverOwn.body.partner.name, 'Tài xế Demo');
    assert.equal(driverOwn.body.rule.commissionAmount, '70000.0000');
  });

  it('running again adds nothing and keeps changed data', async () => {
    const users = await collection('users');
    const before = await users.findOne({ email: 'partner@number160.local' });

    assert.deepEqual(await seedPartners('Another-Passw0rd!'), []);

    const partners = await collection('partners');
    assert.equal(await partners.countDocuments({ nameKey: { $in: ['khách sạn demo', 'hướng dẫn viên demo', 'tài xế demo'] } }), 4);
    assert.equal(await (await collection('commercialRules')).countDocuments({ partnerId: { $in: (await partners.find().toArray()).map((p) => p._id) } }), 4);
    const after = await users.findOne({ email: 'partner@number160.local' });
    assert.equal(after?.passwordHash, before?.passwordHash);
    assert.equal(after?.roles.length, 2);
  });
});

describe('partner edits its own contact', () => {
  it('saves name, phone and email; the merchant sees them; others cannot', async () => {
    const referrer = new Agent(server.baseUrl);
    await referrer.login('referrer@number160.local');
    const bad = await referrer.post('/api/v1/my/partner/contact', { contactEmail: 'not-an-email' });
    assert.equal(bad.status, 422);
    const saved = await referrer.post('/api/v1/my/partner/contact', {
      contactName: ' Minh Chau ',
      contactPhone: '0912 345 678',
      contactEmail: 'Minh@Example.com',
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.contact, { contactName: 'Minh Chau', contactPhone: '0912 345 678', contactEmail: 'minh@example.com' });
    assert.equal((await referrer.get('/api/v1/my/partner')).body.partner.contactPhone, '0912 345 678');

    const admin = new Agent(server.baseUrl);
    await admin.login('admin@number160.local');
    const listed = (await admin.get('/api/v1/partners')).body.partners.find((/** @type {any} */ p) => p.name === 'Hướng dẫn viên Demo');
    assert.equal(listed.contactEmail, 'minh@example.com');
    assert.equal((await admin.post('/api/v1/my/partner/contact', { contactName: 'X' })).status, 403);

    const audit = await (await collection('auditEvents')).findOne({ eventType: 'PARTNER_CONTACT_UPDATED' });
    assert.equal(audit?.after.contactName, 'Minh Chau');
  });
});
