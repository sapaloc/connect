import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closeClient, getDb } from '../src/db/mongo.js';
import { SCHEMA_VERSION, setup } from '../src/db/setup.js';
import { resetDatabase } from './helpers.js';

before(resetDatabase);
after(closeClient);

describe('db:setup on an existing database', () => {
  it('does not call collMod when validators are unchanged (Atlas integration users cannot)', async () => {
    const db = await getDb();
    /** @type {string[]} */
    const commands = [];
    const guarded = new Proxy(db, {
      get(target, prop) {
        if (prop === 'command') {
          return (/** @type {Record<string, unknown>} */ cmd) => {
            commands.push(Object.keys(cmd)[0]);
            if ('collMod' in cmd) throw Object.assign(new Error('not allowed'), { codeName: 'AtlasError' });
            return target.command(cmd);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await setup(guarded);
    assert.ok(!commands.includes('collMod'), `unexpected commands: ${commands.join(', ')}`);
  });

  it('keeps the merchant_applications collection and its pending-unique indexes', async () => {
    const db = await getDb();
    const indexes = await db.collection('merchant_applications').indexes();
    const byName = Object.fromEntries(indexes.map((index) => [index.name, index]));
    assert.deepEqual(byName.pending_email_uq?.partialFilterExpression, { status: 'PENDING' });
    assert.equal(byName.pending_email_uq?.unique, true);
    assert.equal(byName.pending_slug_uq?.unique, true);
  });

  it('records schema v13 with partner_join_requests and the accepting-partners index (no validator change)', async () => {
    const db = await getDb();
    assert.equal(SCHEMA_VERSION, 13);
    assert.equal(await db.collection('schema_versions').countDocuments({ _id: 13 }), 1);
    const requests = Object.fromEntries((await db.collection('partner_join_requests').indexes()).map((index) => [index.name, index]));
    assert.equal(requests.pending_user_tenant_uq?.unique, true);
    assert.deepEqual(requests.pending_user_tenant_uq?.partialFilterExpression, { status: 'PENDING' });
    const tenants = Object.fromEntries((await db.collection('tenants').indexes()).map((index) => [index.name, index]));
    assert.deepEqual(tenants.accepting_partners?.partialFilterExpression, { acceptsNewPartners: true });
    const [tenantCollection] = await db.listCollections({ name: 'tenants' }).toArray();
    assert.ok(!('acceptsNewPartners' in (tenantCollection.options?.validator?.$jsonSchema?.properties ?? {})));
  });

  it('keeps partner_applications and partner_profiles from v12', async () => {
    const db = await getDb();
    const applications = Object.fromEntries((await db.collection('partner_applications').indexes()).map((index) => [index.name, index]));
    assert.equal(applications.pending_email_uq?.unique, true);
    assert.deepEqual(applications.pending_email_uq?.partialFilterExpression, { status: 'PENDING' });
    const profiles = Object.fromEntries((await db.collection('partner_profiles').indexes()).map((index) => [index.name, index]));
    assert.equal(profiles.user_uq?.unique, true);
    const collections = await db.listCollections({ name: { $in: ['partner_applications', 'partner_profiles'] } }).toArray();
    assert.equal(collections.length, 2);
    assert.ok(collections.every((c) => c.options?.validator?.$jsonSchema));
  });
});
