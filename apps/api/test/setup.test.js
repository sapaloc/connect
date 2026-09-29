import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closeClient, getDb } from '../src/db/mongo.js';
import { setup } from '../src/db/setup.js';
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
});
