import { ROLES } from '#domain';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, afterEach, before, describe, it } from 'node:test';
import nodemailer from 'nodemailer';
import { env } from '../src/config/env.js';
import { collection } from '../src/db/mongo.js';
import { seedPartners } from '../src/db/seed-local.js';
import { mailConfigured, sendMail, useTestTransport } from '../src/notify/mail.js';
import { formatVietnamTime, renderEmail } from '../src/notify/templates.js';
import { Agent, PASSWORD, resetDatabase, startServer } from './helpers.js';

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server;
let origin = '';

before(async () => {
  await resetDatabase();
  await seedPartners(PASSWORD);
  server = await startServer();
  origin = env.appOrigin || server.baseUrl;
});

afterEach(() => useTestTransport(undefined));

after(async () => {
  await server?.close();
});

/** @typedef {{ from: string, to: string, subject: string, text: string, html: string }} Sent */

/** In-memory transport: records every message, never opens a connection. */
function capture() {
  /** @type {Sent[]} */
  const outbox = [];
  useTestTransport({
    async sendMail(message) {
      outbox.push(message);
      return { messageId: `test-${outbox.length}` };
    },
  });
  return outbox;
}

/** Captures console output while `fn` runs. @param {() => Promise<void>} fn */
async function logsDuring(fn) {
  const lines = /** @type {string[]} */ ([]);
  const original = { log: console.log, error: console.error, warn: console.warn };
  for (const level of /** @type {const} */ (['log', 'error', 'warn'])) {
    console[level] = (...args) => lines.push(args.map(String).join(' '));
  }
  try {
    await fn();
  } finally {
    Object.assign(console, original);
  }
  return lines.join('\n');
}

const agent = () => new Agent(server.baseUrl);
let counter = 0;

/** @param {'en' | 'vi'} preferredLanguage */
function application(preferredLanguage) {
  counter += 1;
  return {
    name: `Mail Spa ${counter}`,
    contactPhone: '0901 234 567',
    admin: { displayName: `Mail Owner ${counter}`, email: `mail-owner${counter}@lotus.local`, preferredLanguage },
    acceptTerms: true,
    website: '',
  };
}

async function platform() {
  const client = agent();
  assert.equal((await client.login('platform@connect.local')).status, 200);
  return client;
}

/** @param {'en' | 'vi'} language */
async function pending(language) {
  const body = application(language);
  assert.equal((await agent().post('/api/v1/merchant-applications', body)).status, 202);
  const stored = await (await collection('merchantApplications')).findOne({ 'admin.email': body.admin.email, status: 'PENDING' });
  return { body, id: /** @type {string} */ (stored?._id) };
}

async function activePlatformAdmins() {
  const rows = await (await collection('users'))
    .find({ status: 'ACTIVE', roles: { $elemMatch: { role: ROLES.PLATFORM_ADMIN, status: 'ACTIVE' } } })
    .toArray();
  return rows.map((user) => ({ email: user.email, language: user.preferredLanguage === 'vi' ? 'vi' : 'en' }));
}

/**
 * Runs notify() in a child process with a clean environment (no .env, no mail settings).
 * @param {string} appEnv
 */
function notifyInChild(appEnv) {
  const script = `
    const { notify } = await import(${JSON.stringify(new URL('../src/notify/notify.js', import.meta.url).href)});
    const sent = await notify('APPLICATION_APPROVED', {
      to: [{ email: 'owner@child.local', language: 'en' }], name: 'Child Spa', displayName: 'Owner',
      email: 'owner@child.local', temporaryPassword: 'Temp#Child2026xyz', expiresAt: '2026-10-09T09:32:00.000Z',
      origin: 'https://connect.example',
    });
    console.log('RESULT ' + sent);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: process.env.PATH ?? '', APP_ENV: appEnv, LOG_LEVEL: 'info' },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout + child.stderr;
}

describe('email templates', () => {
  const data = {
    name: 'Spa <Lotus>',
    displayName: 'Lan',
    email: 'lan@lotus.local',
    applicantEmail: 'lan@lotus.local',
    reason: 'Not a spa business',
    temporaryPassword: 'Temp#Pass2026abcd',
    expiresAt: '2026-10-09T09:32:00.000Z',
    origin: 'https://connect.example',
  };
  const cases = [
    ['APPLICATION_RECEIVED', { en: 'We received your application', vi: 'Chúng tôi đã nhận đơn đăng ký' }, null],
    ['APPLICATION_NEW_FOR_ADMINS', { en: 'New merchant application', vi: 'Đơn đăng ký merchant mới' }, '/console/merchants'],
    ['APPLICATION_APPROVED', { en: 'is ready', vi: 'đã sẵn sàng' }, '/login'],
    ['APPLICATION_REJECTED', { en: 'was not approved', vi: 'chưa được duyệt' }, '/register'],
    ['TEMPORARY_PASSWORD_REISSUED', { en: 'new MyConnect temporary password', vi: 'Mật khẩu tạm mới' }, '/login'],
  ];

  for (const [type, subjects, path] of /** @type {Array<[string, Record<'en' | 'vi', string>, string | null]>} */ (cases)) {
    for (const language of /** @type {const} */ (['en', 'vi'])) {
      it(`${type} renders in ${language.toUpperCase()} with text and HTML`, () => {
        const email = renderEmail(type, language, data);
        assert.match(email.subject, new RegExp(subjects[language]));
        assert.match(email.html, /font-family:Georgia[^>]*>SAPAWOO</);
        assert.match(email.html, new RegExp(`<html lang="${language}">`));
        assert.match(email.html, /#FBF7EE/);
        assert.ok(!email.html.includes('Spa <Lotus>'), 'values are HTML-escaped');
        if (path) {
          assert.ok(email.text.includes(`https://connect.example${path}`), email.text);
          assert.ok(email.html.includes(`https://connect.example${path}`));
        }
        const hasPassword = type === 'APPLICATION_APPROVED' || type === 'TEMPORARY_PASSWORD_REISSUED';
        assert.equal(email.text.includes(data.temporaryPassword), hasPassword);
        if (hasPassword) {
          assert.ok(email.text.includes('lan@lotus.local'));
          assert.ok(email.text.includes(formatVietnamTime(data.expiresAt, language)));
          assert.match(email.text, language === 'vi' ? /đổi mật khẩu tạm ở lần đăng nhập đầu tiên/ : /Change the temporary password at your first sign-in/);
        }
        if (type === 'APPLICATION_REJECTED') assert.ok(email.text.includes('Not a spa business'));
      });
    }
  }

  it('shows the expiry in Vietnam time', () => {
    assert.equal(formatVietnamTime('2026-10-09T09:32:00.000Z', 'en'), '9 Oct 2026, 16:32');
  });
});

describe('emails on the merchant application flow', () => {
  it('application received (applicant) and new application (each Platform admin, own language)', async () => {
    const outbox = capture();
    const { body } = await pending('vi');
    const toApplicant = outbox.filter((m) => m.to === body.admin.email);
    assert.equal(toApplicant.length, 1);
    assert.match(toApplicant[0].subject, /Chúng tôi đã nhận đơn đăng ký của Mail Spa/);
    assert.ok(toApplicant[0].text.includes(body.name));

    const admins = await activePlatformAdmins();
    assert.ok(admins.length > 0);
    for (const admin of admins) {
      const [mail] = outbox.filter((m) => m.to === admin.email);
      assert.ok(mail, admin.email);
      assert.match(mail.subject, admin.language === 'vi' ? /Đơn đăng ký merchant mới/ : /New merchant application/);
      assert.ok(mail.text.includes(`${origin}/console/merchants`));
      assert.ok(mail.text.includes(body.admin.email));
    }
    assert.equal(outbox.length, admins.length + 1);
  });

  it('approval sends the sign-in email, temporary password and /login link in the applicant language', async () => {
    const { body, id } = await pending('en');
    const outbox = capture();
    const res = await (await platform()).post(`/api/v1/merchant-applications/${id}/approve`, {});
    assert.equal(res.status, 201);
    assert.equal(res.body.emailSent, true);
    assert.equal(outbox.length, 1);
    const [mail] = outbox;
    assert.equal(mail.to, body.admin.email);
    assert.equal(mail.subject, `Your MyConnect account for ${body.name} is ready`);
    assert.ok(mail.text.includes(res.body.temporaryPassword));
    assert.ok(mail.text.includes(`${origin}/login`));
    assert.ok(mail.text.includes(formatVietnamTime(res.body.expiresAt, 'en')));
    assert.ok(mail.html.includes(res.body.temporaryPassword));
  });

  it('rejection sends the reason; a new temporary password is emailed too (VI)', async () => {
    const rejected = await pending('vi');
    const outbox = capture();
    const client = await platform();
    const res = await client.post(`/api/v1/merchant-applications/${rejected.id}/reject`, { reason: 'Không phải spa' });
    assert.equal(res.status, 200);
    assert.equal(res.body.emailSent, true);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].to, rejected.body.admin.email);
    assert.match(outbox[0].subject, /chưa được duyệt/);
    assert.ok(outbox[0].text.includes('Không phải spa'));

    const approved = await pending('vi');
    const approval = await client.post(`/api/v1/merchant-applications/${approved.id}/approve`, {});
    const user = await (await collection('users')).findOne({ email: approved.body.admin.email });
    const reissued = await client.post(`/api/v1/users/${user?._id}/temporary-password`);
    assert.equal(reissued.status, 201);
    assert.equal(reissued.body.emailSent, true);
    const last = outbox[outbox.length - 1];
    assert.equal(last.to, approved.body.admin.email);
    assert.equal(last.subject, 'Mật khẩu tạm mới cho MyConnect');
    assert.ok(last.text.includes(reissued.body.temporaryPassword));
    assert.ok(!last.text.includes(approval.body.temporaryPassword));
    assert.ok(last.text.includes(`${origin}/login`));
  });

  it('builds a real multipart message with nodemailer (JSON transport, no network)', async () => {
    const json = nodemailer.createTransport({ jsonTransport: true });
    /** @type {any[]} */
    const built = [];
    useTestTransport({
      async sendMail(message) {
        const info = await json.sendMail(message);
        built.push(JSON.parse(String(info.message)));
        return info;
      },
    });
    const result = await sendMail({ to: 'someone@lotus.local', ...renderEmail('APPLICATION_RECEIVED', 'en', { name: 'Spa', displayName: 'Lan' }) });
    assert.deepEqual(result, { sent: true });
    assert.equal(built[0].to[0].address, 'someone@lotus.local');
    assert.ok(built[0].text.includes('Hello Lan'));
    assert.ok(built[0].html.includes('SAPAWOO'));
  });
});

describe('when mail is missing or broken, the action still succeeds', () => {
  it('test settings have no mail provider: nothing is sent and nothing throws', async () => {
    assert.equal(mailConfigured(), false);
    assert.deepEqual(await sendMail({ to: 'x@lotus.local', subject: 's', text: 't', html: 'h' }), { sent: false, reason: 'NOT_CONFIGURED' });
  });

  it('missing settings: approve answers 201 with the temporary password and emailSent false', async () => {
    const { id } = await pending('en');
    useTestTransport(null);
    const res = await (await platform()).post(`/api/v1/merchant-applications/${id}/approve`, {});
    assert.equal(res.status, 201);
    assert.equal(res.body.emailSent, false);
    assert.ok(res.body.temporaryPassword);
  });

  it('a transport error is recorded (log + EMAIL_FAILED audit) without secrets; approve still answers 201', async () => {
    const { body, id } = await pending('en');
    useTestTransport({
      async sendMail() {
        throw new Error('535-5.7.8 Username and Password not accepted');
      },
    });
    /** @type {any} */
    let res;
    const logs = await logsDuring(async () => {
      res = await (await platform()).post(`/api/v1/merchant-applications/${id}/approve`, {});
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.emailSent, false);
    assert.ok(res.body.temporaryPassword);
    assert.match(logs, /"msg":"email failed","type":"APPLICATION_APPROVED"/);
    assert.ok(logs.includes(body.admin.email));
    assert.ok(logs.includes('Username and Password not accepted'));
    assert.ok(!logs.includes(res.body.temporaryPassword), 'temporary password never logged');

    const user = await (await collection('users')).findOne({ email: body.admin.email });
    const event = await (await collection('auditEvents')).findOne({ eventType: 'EMAIL_FAILED', entityId: user?._id });
    assert.equal(event?.after.type, 'APPLICATION_APPROVED');
    assert.equal(event?.after.to, body.admin.email);
    assert.ok(!JSON.stringify(event).includes(res.body.temporaryPassword));
  });

  it('a hanging transport is cut off by the timeout; reject and submit still answer', async () => {
    useTestTransport({ sendMail: () => new Promise(() => {}) }, { timeoutMs: 50 });
    let id = '';
    /** @type {any} */
    let res;
    await logsDuring(async () => {
      ({ id } = await pending('vi'));
      res = await (await platform()).post(`/api/v1/merchant-applications/${id}/reject`, { reason: 'Slow mail' });
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.emailSent, false);
    const event = await (await collection('auditEvents')).findOne({ eventType: 'EMAIL_FAILED', entityId: id, 'after.type': 'APPLICATION_REJECTED' });
    assert.match(String(event?.after.error), /not sent within 50 ms/);
  });

  it('local prints the full email; uat logs only type and recipient', () => {
    const local = notifyInChild('local');
    assert.match(local, /Subject: Your MyConnect account for Child Spa is ready/);
    assert.ok(local.includes('Temp#Child2026xyz'));
    assert.match(local, /RESULT false/);

    const uat = notifyInChild('uat');
    assert.match(uat, /"msg":"email not sent: no mail settings","type":"APPLICATION_APPROVED","to":"owner@child.local"/);
    assert.ok(!uat.includes('Temp#Child2026xyz'));
    assert.ok(!uat.includes('Child Spa'));
    assert.match(uat, /RESULT false/);
  });

  it('credentials are masked in error messages', () => {
    const modulePath = new URL('../src/notify/mail.js', import.meta.url).href;
    const script = `
      const { safeErrorMessage, mailConfigured } = await import(${JSON.stringify(modulePath)});
      console.log(String(mailConfigured()));
      console.log(safeErrorMessage(new Error('auth failed for connect.mail@gmail.com with abcd efgh ijkl mnop')));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: {
        PATH: process.env.PATH ?? '',
        APP_ENV: 'uat',
        MAIL_SERVICE: 'gmail',
        MAIL_USER: 'connect.mail@gmail.com',
        MAIL_PASS: 'abcd efgh ijkl mnop',
      },
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, 'true\nauth failed for *** with ***\n');
  });
});
