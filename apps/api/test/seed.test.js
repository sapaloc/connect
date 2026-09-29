import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { fromDecimal128, toDecimal128 } from '../src/db/decimal.js';
import { collection } from '../src/db/mongo.js';
import { SEED_PARTNERS, seedPartners } from '../src/db/seed-local.js';
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
  it('adds one partner per kind with its account, rule and QR, and sets VAT when missing', async () => {
    const created = await seedPartners(PASSWORD);
    assert.deepEqual(created, SEED_PARTNERS.map((sample) => sample.account.email));

    const tenant = await (await collection('tenants')).findOne({ name: 'Number160' });
    assert.equal(fromDecimal128(tenant?.vatRate), '0.1000');

    const partnerAdmin = new Agent(server.baseUrl);
    assert.equal((await partnerAdmin.login('partner@number160.local')).status, 200);
    const mine = await partnerAdmin.get('/api/v1/my/partner');
    assert.equal(mine.status, 200);
    assert.equal(mine.body.partner.name, 'Khách sạn Demo');
    assert.equal(mine.body.partner.relationshipKind, 'COMPANY');
    assert.equal(mine.body.rule.customerDiscountRate, '0.0700');
    assert.match(mine.body.qr.token, /^[A-Za-z0-9_-]{22}$/);

    const referrer = new Agent(server.baseUrl);
    assert.equal((await referrer.login('referrer@number160.local')).status, 200);
    const own = await referrer.get('/api/v1/my/partner');
    assert.equal(own.status, 200);
    assert.equal(own.body.partner.relationshipKind, 'INDEPENDENT_INDIVIDUAL');
  });

  it('running again adds nothing and keeps changed data', async () => {
    const users = await collection('users');
    const before = await users.findOne({ email: 'partner@number160.local' });

    assert.deepEqual(await seedPartners('Another-Passw0rd!'), []);

    const partners = await collection('partners');
    assert.equal(await partners.countDocuments({ nameKey: { $in: ['khách sạn demo', 'hướng dẫn viên demo'] } }), 2);
    assert.equal(await (await collection('commercialRules')).countDocuments({ partnerId: { $in: (await partners.find().toArray()).map((p) => p._id) } }), 2);
    const after = await users.findOne({ email: 'partner@number160.local' });
    assert.equal(after?.passwordHash, before?.passwordHash);
    assert.equal(after?.roles.length, 1);
  });

  it('does not overwrite a VAT rate the merchant already set', async () => {
    const tenants = await collection('tenants');
    await tenants.updateOne({ name: 'Number160' }, { $set: { vatRate: toDecimal128('0.0800') } });
    await seedPartners(PASSWORD);
    assert.equal(fromDecimal128((await tenants.findOne({ name: 'Number160' }))?.vatRate), '0.0800');
  });
});
