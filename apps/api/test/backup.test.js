import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BACKUP_KEEP, exportDatabase, restoreDatabase, writeBackup } from '../src/db/backup.js';
import { collection, getDb } from '../src/db/mongo.js';
import { Agent, resetDatabase, startServer } from './helpers.js';

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server;
/** @type {string} */
let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'connect-backup-'));
  await resetDatabase();
  server = await startServer();
});

after(async () => {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('database backup', () => {
  it('writes a private backup file without sessions', async () => {
    const result = await writeBackup(await getDb(), dir);
    assert.match(result.file, /connect-test-.+\.json\.gz$/);
    assert.equal(result.counts.users, 5);
    assert.equal(result.counts.sessions, undefined, 'sessions are not backed up');
    assert.equal((await stat(result.file)).mode & 0o777, 0o600, 'only the owner can read it');
  });

  it(`keeps only the newest ${BACKUP_KEEP} backups of this environment`, async () => {
    for (let day = 1; day <= BACKUP_KEEP + 2; day += 1) {
      await writeFile(join(dir, `connect-test-2020-01-${String(day).padStart(2, '0')}.json.gz`), 'old');
    }
    await writeFile(join(dir, 'connect-uat-2020-01-01.json.gz'), 'other env');
    const { file } = await writeBackup(await getDb(), dir);
    const files = await readdir(dir);
    assert.equal(files.filter((name) => name.startsWith('connect-test-')).length, BACKUP_KEEP);
    assert.ok(files.includes(file.split('/').pop() ?? ''), 'the new backup is kept');
    assert.ok(!files.includes('connect-test-2020-01-01.json.gz'), 'the oldest is removed');
    assert.ok(files.includes('connect-uat-2020-01-01.json.gz'), 'other environments are left alone');
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
