import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { collection } from '../src/db/mongo.js';
import { Agent, resetDatabase, startServer, tokenFromLink } from './helpers.js';

const NEW_PASSWORD = 'Welcome#2026';

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server;
/** @type {string} */
let number160Id;

before(async () => {
  number160Id = await resetDatabase();
  server = await startServer();
});

after(async () => {
  await server?.close();
});

const agent = () => new Agent(server.baseUrl);

async function platform() {
  const admin = agent();
  await admin.login('platform@connect.local');
  return admin;
}

describe('@permission merchants (MER-01)', () => {
  it('Platform admin creates a merchant and invites its first admin', async () => {
    const admin = await platform();
    const res = await admin.post('/api/v1/merchants', {
      name: 'Phở Sài Gòn',
      contactPhone: '0901 234 567',
      admin: { email: 'Owner@pho.local', displayName: 'Pho Owner', preferredLanguage: 'vi' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.merchant.slug, 'pho-sai-gon');
    assert.equal(res.body.merchant.status, 'ACTIVE');
    assert.equal(res.body.invitation.status, 'INVITED');

    const owner = agent();
    const accepted = await owner.post('/api/v1/auth/invitations/accept', {
      token: tokenFromLink(res.body.invitation.inviteUrl),
      password: NEW_PASSWORD,
    });
    assert.equal(accepted.status, 200);
    const login = await owner.login('owner@pho.local', NEW_PASSWORD);
    assert.equal(login.body.activeRole.role, 'TENANT_ADMIN');
    assert.equal(login.body.activeRole.tenantName, 'Phở Sài Gòn');

    const events = await collection('auditEvents');
    assert.equal(await events.countDocuments({ eventType: 'MERCHANT_CREATED', entityId: res.body.merchant.id }), 1);
  });

  it('lists every merchant with its admin and member counts', async () => {
    const res = await (await platform()).get('/api/v1/merchants');
    assert.equal(res.status, 200);
    const byName = Object.fromEntries(res.body.merchants.map((/** @type {any} */ m) => [m.name, m]));
    assert.equal(byName.Number160.slug, 'number160');
    assert.equal(byName.Number160.admins, 1);
    assert.equal(byName.Number160.members, 3);
    assert.equal(byName['Phở Sài Gòn'].admins, 1);
  });

  it('rejects a duplicate merchant name', async () => {
    const res = await (await platform()).post('/api/v1/merchants', { name: 'Number160' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'MERCHANT_EXISTS');
  });

  it('a merchant admin cannot list, create or pause merchants', async () => {
    const tenantAdmin = agent();
    await tenantAdmin.login('admin@number160.local');
    assert.equal((await tenantAdmin.get('/api/v1/merchants')).status, 403);
    assert.equal((await tenantAdmin.post('/api/v1/merchants', { name: 'Mine' })).status, 403);
    assert.equal((await tenantAdmin.post(`/api/v1/merchants/${number160Id}/status`, { status: 'PAUSED' })).status, 403);
  });
});

describe('@permission paused merchant (MER-02)', () => {
  it('its people lose access while paused and get it back after resume', async () => {
    const admin = await platform();
    const staff = agent();
    await staff.login('staff@number160.local');

    const paused = await admin.post(`/api/v1/merchants/${number160Id}/status`, { status: 'PAUSED' });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.merchant.status, 'PAUSED');
    assert.equal((await staff.get('/api/v1/auth/me')).status, 401);
    assert.equal((await agent().login('staff@number160.local')).status, 403);

    const resumed = await admin.post(`/api/v1/merchants/${number160Id}/status`, { status: 'ACTIVE' });
    assert.equal(resumed.body.merchant.status, 'ACTIVE');
    assert.equal((await staff.login('staff@number160.local')).status, 200);
  });

  it('rejects an unknown status', async () => {
    const res = await (await platform()).post(`/api/v1/merchants/${number160Id}/status`, { status: 'ENDED' });
    assert.equal(res.status, 422);
  });
});
