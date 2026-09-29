import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { env } from '../src/config/env.js';
import { BACKUP_KEEP, backupPrefix, exportDatabase, restoreDatabase } from '../src/db/backup.js';
import { collection, getDb } from '../src/db/mongo.js';
import { getStorage } from '../src/storage/storage.js';
import { Agent, resetDatabase, startServer } from './helpers.js';

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server;

before(async () => {
  await rm(env.storage.endpoint, { recursive: true, force: true });
  await resetDatabase();
  server = await startServer();
});

after(async () => {
  await server?.close();
  await rm(env.storage.endpoint, { recursive: true, force: true });
});

/** @param {string} [authorization] */
function runJob(authorization) {
  return fetch(`${server.baseUrl}/api/v1/internal/jobs/backup`, {
    headers: authorization ? { authorization } : {},
  });
}

describe('database backup', () => {
  it('the job refuses callers without the cron secret', async () => {
    assert.equal((await runJob()).status, 401);
    assert.equal((await runJob('Bearer wrong-secret')).status, 401);
    assert.equal((await runJob(env.cronSecret)).status, 401);
  });

  it('the job uploads a backup to private storage and records it', async () => {
    const res = await runJob(`Bearer ${env.cronSecret}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.path, /^backups\/test\/connect-test-.+\.json\.gz$/);
    assert.equal(body.counts.users, 5);
    assert.equal(body.counts.sessions, undefined, 'sessions are not backed up');
    assert.deepEqual(await getStorage().list(backupPrefix()), [body.path]);
    const audit = await (await collection('auditEvents')).findOne({ eventType: 'DATABASE_BACKUP_CREATED' });
    assert.equal(audit?.entityId, body.path);
  });

  it(`keeps only the newest ${BACKUP_KEEP} backups`, async () => {
    const storage = getStorage();
    for (let day = 1; day <= BACKUP_KEEP + 2; day += 1) {
      await storage.put(`${backupPrefix()}connect-test-2020-01-${String(day).padStart(2, '0')}.json.gz`, Buffer.from('old'), 'application/gzip');
    }
    const res = await runJob(`Bearer ${env.cronSecret}`);
    const { path } = await res.json();
    const files = await storage.list(backupPrefix());
    assert.equal(files.length, BACKUP_KEEP);
    assert.ok(files.includes(path), 'the new backup is kept');
    assert.ok(!files.includes(`${backupPrefix()}connect-test-2020-01-01.json.gz`), 'the oldest is removed');
  });

  it('restore brings back every document with its exact types', async () => {
    const admin = new Agent(server.baseUrl);
    await admin.login('admin@number160.local');
    await admin.post('/api/v1/users/invitations', { email: 'kept@number160.local', displayName: 'Kept', role: 'STAFF' });

    const db = await getDb();
    const before = await (await collection('invitations')).findOne({});
    const backup = await exportDatabase(db);

    await (await collection('users')).deleteMany({});
    await (await collection('invitations')).deleteMany({});
    const result = await restoreDatabase(db, backup.body);

    assert.equal(result.counts.users, 6);
    const restored = await (await collection('invitations')).findOne({ _id: before?._id });
    assert.ok(restored?.expiresAt instanceof Date);
    assert.equal(restored?.tokenHash.toString('hex'), before?.tokenHash.toString('hex'));
    const login = await new Agent(server.baseUrl).login('staff@number160.local');
    assert.equal(login.status, 200, 'restored password hashes still work');
    const indexes = (await (await collection('users')).indexes()).map((index) => index.name);
    assert.ok(indexes.includes('email_uq'), 'indexes are recreated');
  });
});
