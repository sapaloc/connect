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

  it('records schema v11 with the merchant_applications collection and its pending-unique indexes', async () => {
    const db = await getDb();
    assert.equal(SCHEMA_VERSION, 11);
    assert.equal(await db.collection('schema_versions').countDocuments({ _id: 11 }), 1);
    const indexes = await db.collection('merchant_applications').indexes();
    const byName = Object.fromEntries(indexes.map((index) => [index.name, index]));
    assert.deepEqual(byName.pending_email_uq?.partialFilterExpression, { status: 'PENDING' });
    assert.equal(byName.pending_email_uq?.unique, true);
    assert.equal(byName.pending_slug_uq?.unique, true);
  });
});
