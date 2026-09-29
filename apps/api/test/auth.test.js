import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { collection } from '../src/db/mongo.js';
import { Agent, PASSWORD, resetDatabase, startServer, tokenFromLink } from './helpers.js';

const NEW_PASSWORD = 'Welcome#2026';

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server;

before(async () => {
  await resetDatabase();
  server = await startServer();
});

after(async () => {
  await server?.close();
});

const agent = () => new Agent(server.baseUrl);

describe('@permission sign-in', () => {
  it('rejects a wrong password and an unknown email with the same response', async () => {
    const wrong = await agent().login('staff@number160.local', 'Wrong#2026x');
    const unknown = await agent().login('nobody@number160.local', 'Wrong#2026x');
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
    assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS');
  });

  it('signs Staff in straight to the scanner with a hardened cookie', async () => {
    const staff = agent();
    const res = await staff.login('STAFF@number160.local');
    assert.equal(res.status, 200);
    assert.equal(res.body.activeRole.role, 'STAFF');
    assert.equal(res.body.landing, '/counter');
    assert.ok(res.body.permissions.includes('redemption.create'));
    assert.ok(!res.body.permissions.includes('surface.console'));
    assert.match(res.setCookie ?? '', /HttpOnly/);
    assert.match(res.setCookie ?? '', /SameSite=Lax/);
    assert.equal((await staff.get('/api/v1/auth/me')).body.user.email, 'staff@number160.local');
  });

  it('never exposes the password hash', async () => {
    const res = await agent().login('admin@number160.local');
    assert.doesNotMatch(JSON.stringify(res.body), /scrypt|password/i);
  });

  it('requires a session for protected routes', async () => {
    const res = await agent().get('/api/v1/auth/me');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'UNAUTHENTICATED');
  });
});

describe('@permission role boundaries', () => {
  it('Staff cannot invite or list users', async () => {
    const staff = agent();
    await staff.login('staff@number160.local');
    const invite = await staff.post('/api/v1/users/invitations', {
      email: 'x@number160.local',
      displayName: 'X',
      role: 'STAFF',
    });
    assert.equal(invite.status, 403);
    assert.equal(invite.body.error.code, 'FORBIDDEN');
    assert.equal((await staff.get('/api/v1/users')).status, 403);
  });

  it('Manager cannot invite users', async () => {
    const manager = agent();
    await manager.login('manager@number160.local');
    const res = await manager.post('/api/v1/users/invitations', {
      email: 'y@number160.local',
      displayName: 'Y',
      role: 'STAFF',
    });
    assert.equal(res.status, 403);
  });

  it('Tenant Admin cannot invite a Platform Admin', async () => {
    const admin = agent();
    await admin.login('admin@number160.local');
    const res = await admin.post('/api/v1/users/invitations', {
      email: 'z@number160.local',
      displayName: 'Z',
      role: 'PLATFORM_ADMIN',
    });
    assert.equal(res.status, 403);
  });

  it('a user with several roles must choose; no highest-privilege default (C3)', async () => {
    const multi = agent();
    const login = await multi.login('multi@number160.local');
    assert.equal(login.status, 200);
    assert.equal(login.body.activeRole, null);
    assert.equal(login.body.needsRoleSelection, true);
    assert.deepEqual(login.body.permissions, []);
    assert.equal(login.body.roles.length, 2);

    const blocked = await multi.get('/api/v1/users');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'ROLE_NOT_SELECTED');

    const pendingCookie = multi.cookie;
    const manager = login.body.roles.find((/** @type {any} */ r) => r.role === 'MANAGER');
    const selected = await multi.post('/api/v1/auth/select-role', { roleAssignmentId: manager.roleAssignmentId });
    assert.equal(selected.status, 200);
    assert.equal(selected.body.activeRole.role, 'MANAGER');
    assert.notEqual(multi.cookie, pendingCookie, 'role change must issue a new session');
    assert.equal((await multi.get('/api/v1/users')).status, 403, 'Manager role cannot list users');

    const stale = new Agent(server.baseUrl);
    stale.cookie = pendingCookie;
    assert.equal((await stale.get('/api/v1/auth/me')).status, 401, 'old session is revoked');
  });

  it('cannot select a role assignment that belongs to someone else', async () => {
    const admin = agent();
    const adminLogin = await admin.login('admin@number160.local');
    const staff = agent();
    await staff.login('staff@number160.local');
    const res = await staff.post('/api/v1/auth/select-role', {
      roleAssignmentId: adminLogin.body.activeRole.roleAssignmentId,
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'ROLE_NOT_AVAILABLE');
  });

  it('Tenant Admin cannot issue a reset link for the Platform Admin', async () => {
    const platform = agent();
    const platformLogin = await platform.login('platform@connect.local');
    const admin = agent();
    await admin.login('admin@number160.local');
    const res = await admin.post(`/api/v1/users/${platformLogin.body.user.id}/password-reset`);
    assert.equal(res.status, 404);
  });

  it('blocks cross-site writes', async () => {
    const res = await agent().post(
      '/api/v1/auth/login',
      { email: 'admin@number160.local', password: PASSWORD },
      { origin: 'https://evil.example' },
    );
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'ORIGIN_MISMATCH');
  });

  it('rejects non-JSON bodies', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'email=a',
    });
    assert.equal(res.status, 415);
  });
});

describe('@permission invitation', () => {
  it('invite → accept with policy check → sign in → link cannot be reused (E2E-S1-03)', async () => {
    const admin = agent();
    await admin.login('admin@number160.local');
    const invite = await admin.post('/api/v1/users/invitations', {
      email: 'new.staff@number160.local',
      displayName: 'New Staff',
      role: 'STAFF',
    });
    assert.equal(invite.status, 201);
    assert.equal(invite.body.status, 'INVITED');
    const token = tokenFromLink(invite.body.inviteUrl);

    const guest = agent();
    const inspected = await guest.post('/api/v1/auth/invitations/inspect', { token });
    assert.equal(inspected.body.email, 'new.staff@number160.local');

    const weak = await guest.post('/api/v1/auth/invitations/accept', { token, password: 'weakpass' });
    assert.equal(weak.status, 422);
    assert.equal(weak.body.error.code, 'PASSWORD_POLICY');
    assert.deepEqual(weak.body.error.details.rules, ['UPPER', 'DIGIT', 'SPECIAL']);

    const accepted = await guest.post('/api/v1/auth/invitations/accept', { token, password: NEW_PASSWORD });
    assert.equal(accepted.status, 200);

    const login = await agent().login('new.staff@number160.local', NEW_PASSWORD);
    assert.equal(login.status, 200);
    assert.equal(login.body.landing, '/counter');

    const reuse = await guest.post('/api/v1/auth/invitations/accept', { token, password: NEW_PASSWORD });
    assert.equal(reuse.status, 410);

    const audit = await (await collection('auditEvents'))
      .find({ eventType: { $in: ['INVITATION_CREATED', 'INVITATION_ACCEPTED'] } })
      .toArray();
    assert.equal(audit.length, 2);
    assert.doesNotMatch(JSON.stringify(audit), new RegExp(token));
  });

  it('an expired invitation creates no account (E2E-S1-02)', async () => {
    const admin = agent();
    await admin.login('admin@number160.local');
    const invite = await admin.post('/api/v1/users/invitations', {
      email: 'late@number160.local',
      displayName: 'Late',
      role: 'MANAGER',
    });
    await (await collection('invitations')).updateMany(
      { userId: invite.body.userId },
      { $set: { expiresAt: new Date(Date.now() - 60_000) } },
    );
    const res = await agent().post('/api/v1/auth/invitations/accept', {
      token: tokenFromLink(invite.body.inviteUrl),
      password: NEW_PASSWORD,
    });
    assert.equal(res.status, 410);
    assert.equal(res.body.error.code, 'INVITATION_INVALID');
    const user = await (await collection('users')).findOne({ _id: invite.body.userId });
    assert.equal(user?.status, 'INVITED');
  });

  it('re-sending an invitation revokes the previous link', async () => {
    const admin = agent();
    await admin.login('admin@number160.local');
    const body = { email: 'resend@number160.local', displayName: 'Resend', role: 'STAFF' };
    const first = await admin.post('/api/v1/users/invitations', body);
    const second = await admin.post('/api/v1/users/invitations', body);
    const guest = agent();
    const old = await guest.post('/api/v1/auth/invitations/inspect', { token: tokenFromLink(first.body.inviteUrl) });
    assert.equal(old.status, 410);
    const current = await guest.post('/api/v1/auth/invitations/inspect', { token: tokenFromLink(second.body.inviteUrl) });
    assert.equal(current.status, 200);
  });
});

describe('@permission password reset', () => {
  it('the public request answers the same for known and unknown emails (E2E-S1-06)', async () => {
    const known = await agent().post('/api/v1/auth/password-reset', { email: 'manager@number160.local' });
    const unknown = await agent().post('/api/v1/auth/password-reset', { email: 'ghost@number160.local' });
    assert.equal(known.status, 202);
    assert.equal(unknown.status, known.status);
    assert.deepEqual(unknown.body, known.body);
  });

  it('admin reset link → new password → every old session signed out', async () => {
    const manager = agent();
    const login = await manager.login('manager@number160.local');
    assert.equal((await manager.get('/api/v1/auth/me')).status, 200);

    const admin = agent();
    await admin.login('admin@number160.local');
    const issued = await admin.post(`/api/v1/users/${login.body.user.id}/password-reset`);
    assert.equal(issued.status, 201);

    const confirm = await agent().post('/api/v1/auth/password-reset/confirm', {
      token: tokenFromLink(issued.body.resetUrl),
      password: NEW_PASSWORD,
    });
    assert.equal(confirm.status, 200);
    assert.equal((await manager.get('/api/v1/auth/me')).status, 401);
    assert.equal((await agent().login('manager@number160.local')).status, 401);
    assert.equal((await agent().login('manager@number160.local', NEW_PASSWORD)).status, 200);

    const again = await agent().post('/api/v1/auth/password-reset/confirm', {
      token: tokenFromLink(issued.body.resetUrl),
      password: 'Another#2026',
    });
    assert.equal(again.status, 410);
  });
});

describe('@permission sessions and rate limits', () => {
  it('logout revokes the session on the server', async () => {
    const staff = agent();
    await staff.login('staff@number160.local');
    const cookie = staff.cookie;
    assert.equal((await staff.post('/api/v1/auth/logout')).status, 200);
    const replay = new Agent(server.baseUrl);
    replay.cookie = cookie;
    assert.equal((await replay.get('/api/v1/auth/me')).status, 401);
  });

  it('an expired session is rejected', async () => {
    const staff = agent();
    const login = await staff.login('staff@number160.local');
    await (await collection('sessions')).updateMany(
      { userId: login.body.user.id, revokedAt: null },
      { $set: { idleExpiresAt: new Date(Date.now() - 1000) } },
    );
    assert.equal((await staff.get('/api/v1/auth/me')).status, 401);
  });

  it('a blocked account loses access immediately', async () => {
    const admin = agent();
    await admin.login('admin@number160.local');
    const invite = await admin.post('/api/v1/users/invitations', {
      email: 'blocked@number160.local',
      displayName: 'Blocked',
      role: 'STAFF',
    });
    await agent().post('/api/v1/auth/invitations/accept', {
      token: tokenFromLink(invite.body.inviteUrl),
      password: NEW_PASSWORD,
    });
    const user = agent();
    await user.login('blocked@number160.local', NEW_PASSWORD);
    await (await collection('users')).updateOne({ _id: invite.body.userId }, { $set: { status: 'BLOCKED' } });
    assert.equal((await user.get('/api/v1/auth/me')).status, 401);
    assert.equal((await agent().login('blocked@number160.local', NEW_PASSWORD)).status, 401);
  });

  it('locks sign-in after 5 wrong passwords, with Retry-After', async () => {
    const attacker = agent();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await attacker.login('admin@number160.local', 'Wrong#2026x')).status, 401);
    }
    const locked = await attacker.login('admin@number160.local');
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error.code, 'RATE_LIMITED');
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    assert.equal((await agent().login('admin@number160.local')).status, 200, 'other IPs are not locked out');
  });

  it('records sign-in audit events without secrets', async () => {
    const rows = await (await collection('auditEvents'))
      .find({ eventType: { $in: ['SIGN_IN', 'SIGN_IN_FAILED'] } }, { projection: { eventType: 1, after: 1 } })
      .toArray();
    assert.ok(rows.some((row) => row.eventType === 'SIGN_IN'));
    assert.ok(rows.some((row) => row.eventType === 'SIGN_IN_FAILED'));
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(PASSWORD.replace(/[#$^*+?.()|[\]{}\\]/g, '\\$&')));
  });

  it('audit events are only ever inserted, by audit.js alone', async () => {
    const sourceDir = new URL('../src/', import.meta.url);
    const files = (await readdir(sourceDir, { recursive: true })).filter((file) => file.endsWith('.js'));
    for (const file of files) {
      const source = await readFile(new URL(file, sourceDir), 'utf8');
      const touchesAudit = /auditEvents|audit_events/.test(source);
      if (file === join('audit', 'audit.js')) {
        assert.doesNotMatch(source, /\.(update|replace|delete|findOneAnd|bulkWrite|drop)\w*\(/, file);
      } else if (touchesAudit) {
        assert.ok(file === join('db', 'mongo.js') || file === join('db', 'setup.js'), `${file} must use recordAudit`);
      }
    }
  });

  it('the database rejects documents that break the schema', async () => {
    const users = await collection('users');
    await assert.rejects(
      users.insertOne({ _id: crypto.randomUUID(), email: 'nopass@number160.local', displayName: 'No password',
        status: 'ACTIVE', preferredLanguage: 'en', roles: [], createdAt: new Date(), updatedAt: new Date() }),
      /Document failed validation/,
    );
    await assert.rejects(
      users.insertOne({ _id: crypto.randomUUID(), email: 'staff@number160.local', displayName: 'Duplicate',
        status: 'INVITED', preferredLanguage: 'en', roles: [], createdAt: new Date(), updatedAt: new Date() }),
      /duplicate key/,
    );
  });
});
