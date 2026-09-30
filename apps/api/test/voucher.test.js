import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ROLES } from '#domain';
import sharp from 'sharp';
import { ensureActiveUser, ensureTenant } from '../src/db/bootstrap.js';
import { collection } from '../src/db/mongo.js';
import { endOfVietnamDay } from '../src/vouchers/voucher-routes.js';
import { Agent, PASSWORD, resetDatabase, startServer } from './helpers.js';

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server;

/** YYYY-MM-DD in Vietnam, `days` from now. */
function vnDate(days) {
  return new Date(Date.now() + 7 * 3600_000 + days * 86_400_000).toISOString().slice(0, 10);
}

before(async () => {
  await resetDatabase();
  const other = await ensureTenant('Other Shop');
  await ensureActiveUser({ email: 'admin@other.local', displayName: 'Other Admin', password: PASSWORD, role: ROLES.TENANT_ADMIN, tenantId: other });
  await ensureActiveUser({ email: 'staff@other.local', displayName: 'Other Staff', password: PASSWORD, role: ROLES.STAFF, tenantId: other });
  server = await startServer();
});

after(async () => {
  await server?.close();
});

/** @param {string} email */
async function signedIn(email) {
  const agent = new Agent(server.baseUrl);
  const res = await agent.login(email);
  assert.equal(res.status, 200, email);
  return agent;
}

const TERMS = { discountType: 'PERCENT', discountValue: '10', validUntil: vnDate(30) };

describe('valid-until date', () => {
  it('ends at 23:59:59.999 Vietnam time', () => {
    assert.equal(endOfVietnamDay('2026-10-31')?.toISOString(), '2026-10-31T16:59:59.999Z');
    assert.equal(endOfVietnamDay('2026-02-30'), null);
    assert.equal(endOfVietnamDay('31/10/2026'), null);
  });
});

describe('@permission issuing vouchers', () => {
  it('VCH-01: a batch of 5 gives 5 distinct codes sharing one batch id and one audit event', async () => {
    const admin = await signedIn('admin@number160.local');
    const res = await admin.post('/api/v1/vouchers', { ...TERMS, quantity: 5, note: 'Grand opening' });
    assert.equal(res.status, 201);
    assert.equal(res.body.vouchers.length, 5);
    assert.equal(new Set(res.body.vouchers.map((/** @type {any} */ v) => v.code)).size, 5);
    for (const voucher of res.body.vouchers) {
      assert.match(voucher.code, /^[A-HJ-NP-Z2-9]{8}$/);
      assert.equal(voucher.batchId, res.body.batchId);
      assert.equal(voucher.discountValue, '0.1000');
      assert.equal(voucher.status, 'ACTIVE');
      assert.equal(voucher.merchantName, 'Number160');
    }
    const listed = await admin.get(`/api/v1/vouchers?batchId=${res.body.batchId}`);
    assert.equal(listed.body.vouchers.length, 5);
    const events = await collection('auditEvents');
    assert.equal(await events.countDocuments({ eventType: 'VOUCHER_ISSUED', entityId: res.body.batchId }), 1);
  });

  it('Manager issues a fixed-amount voucher with a minimum bill', async () => {
    const manager = await signedIn('manager@number160.local');
    const res = await manager.post('/api/v1/vouchers', {
      discountType: 'AMOUNT',
      discountValue: '200000',
      minBillAmount: '1000000',
      validUntil: vnDate(7),
      customerName: 'Chị Lan',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.batchId, null);
    assert.equal(res.body.vouchers[0].discountValue, '200000.0000');
    assert.equal(res.body.vouchers[0].minBillAmount, '1000000.0000');
  });

  it('Staff and Platform admin cannot issue', async () => {
    assert.equal((await (await signedIn('staff@number160.local')).post('/api/v1/vouchers', TERMS)).status, 403);
    assert.equal((await (await signedIn('platform@connect.local')).post('/api/v1/vouchers', TERMS)).status, 403);
  });

  it('rejects invalid terms', async () => {
    const admin = await signedIn('admin@number160.local');
    for (const body of [
      { ...TERMS, discountValue: '150' },
      { ...TERMS, discountType: 'FREE' },
      { ...TERMS, validUntil: vnDate(-1) },
      { ...TERMS, validUntil: vnDate(400) },
      { ...TERMS, quantity: 201 },
      { ...TERMS, quantity: 1.5 },
    ]) {
      const res = await admin.post('/api/v1/vouchers', body);
      assert.equal(res.status, 422, JSON.stringify(body));
    }
  });
});

describe('@permission listing vouchers', () => {
  it('a merchant only sees its own vouchers', async () => {
    const other = await signedIn('admin@other.local');
    await other.post('/api/v1/vouchers', { ...TERMS, customerName: 'Other customer' });
    const mine = await other.get('/api/v1/vouchers');
    assert.equal(mine.status, 200);
    assert.equal(mine.body.vouchers.length, 1);
    assert.equal(mine.body.counts.ACTIVE, 1);

    const number160 = await (await signedIn('admin@number160.local')).get('/api/v1/vouchers?q=other');
    assert.equal(number160.body.vouchers.length, 0);
  });

  it('Platform admin sees every merchant and can filter by one', async () => {
    const platform = await signedIn('platform@connect.local');
    const all = await platform.get('/api/v1/vouchers');
    assert.deepEqual(new Set(all.body.vouchers.map((/** @type {any} */ v) => v.merchantName)), new Set(['Number160', 'Other Shop']));
    const one = await platform.get(`/api/v1/vouchers?merchantId=${all.body.vouchers.find((/** @type {any} */ v) => v.merchantName === 'Other Shop').merchantId}`);
    assert.equal(one.body.vouchers.length, 1);
  });

  it('Staff cannot list vouchers', async () => {
    assert.equal((await (await signedIn('staff@number160.local')).get('/api/v1/vouchers')).status, 403);
  });

  it('shows an active voucher past its end as expired', async () => {
    const admin = await signedIn('admin@number160.local');
    const created = await admin.post('/api/v1/vouchers', { ...TERMS, customerName: 'Late' });
    const vouchers = await collection('vouchers');
    await vouchers.updateOne({ code: created.body.vouchers[0].code }, { $set: { validUntil: new Date(Date.now() - 1000) } });
    const expired = await admin.get('/api/v1/vouchers?status=EXPIRED');
    assert.deepEqual(expired.body.vouchers.map((/** @type {any} */ v) => v.customerName), ['Late']);
    assert.equal(expired.body.counts.EXPIRED, 1);
    assert.ok(!(await admin.get('/api/v1/vouchers?status=ACTIVE')).body.vouchers.some((/** @type {any} */ v) => v.customerName === 'Late'));
  });
});

describe('@permission public voucher page (VCH-06)', () => {
  it('shows terms and status without customer name or note', async () => {
    const admin = await signedIn('admin@number160.local');
    const created = await admin.post('/api/v1/vouchers', { ...TERMS, customerName: 'Secret Name', note: 'Secret note' });
    const code = created.body.vouchers[0].code;
    const res = await new Agent(server.baseUrl).get(`/api/v1/public/vouchers/${code.slice(0, 4)}-${code.slice(4)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.voucher.merchantName, 'Number160');
    assert.equal(res.body.voucher.status, 'ACTIVE');
    assert.doesNotMatch(JSON.stringify(res.body), /Secret|createdBy|tenantId|batchId/);
  });

  it('answers 404 for an unknown or malformed code', async () => {
    const anonymous = new Agent(server.baseUrl);
    assert.equal((await anonymous.get('/api/v1/public/vouchers/ZZZZ2222')).status, 404);
    assert.equal((await anonymous.get('/api/v1/public/vouchers/not-a-code')).status, 404);
  });
});

describe('@permission voiding a voucher', () => {
  it('voids once with a reason; another merchant gets 404', async () => {
    const admin = await signedIn('admin@number160.local');
    const code = (await admin.post('/api/v1/vouchers', TERMS)).body.vouchers[0].code;

    assert.equal((await (await signedIn('admin@other.local')).post(`/api/v1/vouchers/${code}/void`, { reason: 'x' })).status, 404);
    assert.equal((await admin.post(`/api/v1/vouchers/${code}/void`, { reason: '' })).status, 422);

    const voided = await admin.post(`/api/v1/vouchers/${code}/void`, { reason: 'Sent to the wrong customer' });
    assert.equal(voided.status, 200);
    assert.equal(voided.body.voucher.status, 'VOID');
    assert.equal(voided.body.voucher.voidReason, 'Sent to the wrong customer');

    const again = await admin.post(`/api/v1/vouchers/${code}/void`, { reason: 'again' });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'VOUCHER_NOT_ACTIVE');
    assert.equal((await new Agent(server.baseUrl).get(`/api/v1/public/vouchers/${code}`)).body.voucher.status, 'VOID');
  });

  it('Staff cannot void', async () => {
    const code = (await (await signedIn('admin@number160.local')).post('/api/v1/vouchers', TERMS)).body.vouchers[0].code;
    assert.equal((await (await signedIn('staff@number160.local')).post(`/api/v1/vouchers/${code}/void`, { reason: 'x' })).status, 403);
  });
});

/** @param {Record<string, unknown>} [terms] */
async function issueOne(terms = TERMS) {
  const res = await (await signedIn('admin@number160.local')).post('/api/v1/vouchers', terms);
  assert.equal(res.status, 201);
  return /** @type {string} */ (res.body.vouchers[0].code);
}

describe('@money @permission redeeming at the counter', () => {
  it('Staff looks the voucher up and redeems it with the right amounts', async () => {
    const code = await issueOne({ ...TERMS, customerName: 'Anh Minh' });
    const staff = await signedIn('staff@number160.local');
    const lookup = await staff.get(`/api/v1/vouchers/${code.toLowerCase()}`);
    assert.equal(lookup.status, 200);
    assert.equal(lookup.body.voucher.customerName, 'Anh Minh');

    const res = await staff.post(`/api/v1/vouchers/${code}/redeem`, { grossAmount: '1000000' });
    assert.equal(res.status, 200);
    assert.equal(res.body.voucher.status, 'REDEEMED');
    assert.deepEqual(
      { ...res.body.voucher.redemption, redeemedAt: undefined },
      { grossAmount: '1000000.0000', discountAmount: '100000.0000', payableAmount: '900000.0000', redeemedAt: undefined },
    );
    const events = await collection('auditEvents');
    assert.equal(await events.countDocuments({ eventType: 'VOUCHER_REDEEMED' }), 1);
  });

  it('VCH-04: two counters confirming at once give one success and one 409', async () => {
    const code = await issueOne();
    const [staff, manager] = await Promise.all([signedIn('staff@number160.local'), signedIn('manager@number160.local')]);
    const results = await Promise.all([
      staff.post(`/api/v1/vouchers/${code}/redeem`, { grossAmount: '500000' }),
      manager.post(`/api/v1/vouchers/${code}/redeem`, { grossAmount: '600000' }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(results.find((r) => r.status === 409)?.body.error.code, 'VOUCHER_ALREADY_REDEEMED');
    const vouchers = await collection('vouchers');
    assert.equal((await vouchers.findOne({ code }))?.status, 'REDEEMED');
  });

  it('VCH-05: another merchant cannot look up or redeem it', async () => {
    const code = await issueOne();
    const otherStaff = await signedIn('staff@other.local');
    assert.equal((await otherStaff.get(`/api/v1/vouchers/${code}`)).status, 404);
    assert.equal((await otherStaff.post(`/api/v1/vouchers/${code}/redeem`, { grossAmount: '100000' })).status, 404);
  });

  it('refuses a bill below the minimum, then accepts it at the minimum', async () => {
    const code = await issueOne({ discountType: 'AMOUNT', discountValue: '200000', minBillAmount: '1000000', validUntil: vnDate(3) });
    const staff = await signedIn('staff@number160.local');
    const low = await staff.post(`/api/v1/vouchers/${code}/redeem`, { grossAmount: '999999' });
    assert.equal(low.status, 422);
    assert.equal(low.body.error.code, 'BELOW_MIN_BILL');
    const ok = await staff.post(`/api/v1/vouchers/${code}/redeem`, { grossAmount: 1000000 });
    assert.equal(ok.body.voucher.redemption.payableAmount, '800000.0000');
  });

  it('refuses expired and voided vouchers', async () => {
    const expired = await issueOne();
    const vouchers = await collection('vouchers');
    await vouchers.updateOne({ code: expired }, { $set: { validUntil: new Date(Date.now() - 1000) } });
    const voided = await issueOne();
    await (await signedIn('admin@number160.local')).post(`/api/v1/vouchers/${voided}/void`, { reason: 'test' });

    const staff = await signedIn('staff@number160.local');
    assert.equal((await staff.post(`/api/v1/vouchers/${expired}/redeem`, { grossAmount: '100000' })).body.error.code, 'VOUCHER_EXPIRED');
    assert.equal((await staff.post(`/api/v1/vouchers/${voided}/redeem`, { grossAmount: '100000' })).body.error.code, 'VOUCHER_VOID');
  });

  it('Merchant admin cannot redeem', async () => {
    const code = await issueOne();
    assert.equal((await (await signedIn('admin@number160.local')).post(`/api/v1/vouchers/${code}/redeem`, { grossAmount: '1' })).status, 403);
  });

  it('the public page offers redeem only to a counter role of the same merchant', async () => {
    const code = await issueOne();
    const path = `/api/v1/public/vouchers/${code}`;
    assert.equal((await new Agent(server.baseUrl).get(path)).body.canRedeem, false);
    assert.equal((await (await signedIn('staff@number160.local')).get(path)).body.canRedeem, true);
    assert.equal((await (await signedIn('staff@other.local')).get(path)).body.canRedeem, false);
    assert.equal((await (await signedIn('admin@number160.local')).get(path)).body.canRedeem, false);
  });
});

describe('@permission bill photos', () => {
  /**
   * @param {Agent} agent
   * @param {string} path
   * @param {Buffer} body
   */
  async function upload(agent, path, body) {
    const res = await fetch(agent.baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', cookie: agent.cookie, 'x-forwarded-for': agent.ip },
      body,
    });
    return { status: res.status, body: await res.json() };
  }

  const billJpeg = () => sharp({ create: { width: 1200, height: 1800, channels: 3, background: '#F4F1EA' } }).jpeg().toBuffer();

  /** @type {string} */
  let code;

  it('a guest adds up to 3 photos from the voucher page; the public page only shows the count', async () => {
    const manager = await signedIn('manager@number160.local');
    code = (await manager.post('/api/v1/vouchers', TERMS)).body.vouchers[0].code;
    const guest = new Agent(server.baseUrl);
    const path = `/api/v1/public/vouchers/${code}/bill-photos`;
    for (let n = 1; n <= 3; n++) {
      const res = await upload(guest, path, await billJpeg());
      assert.equal(res.status, 201);
      assert.equal(res.body.guestBillPhotos, n);
    }
    const full = await upload(guest, path, await billJpeg());
    assert.equal(full.status, 409);
    assert.equal(full.body.error.code, 'BILL_PHOTOS_FULL');
    const shown = await guest.get(`/api/v1/public/vouchers/${code}`);
    assert.equal(shown.body.voucher.guestBillPhotos, 3);
    assert.doesNotMatch(JSON.stringify(shown.body), /bill-photos|assetId/);

    const files = await collection('fileAssets');
    const stored = await files.find({ assetType: 'PAYMENT_RECEIPT' }).toArray();
    assert.equal(stored.length, 3);
    assert.ok(stored.every((asset) => asset.mimeType === 'image/webp' && Math.max(asset.width, asset.height) <= 1600 && asset.createdBy === null));
  });

  it('refuses a file that is not an image', async () => {
    const manager = await signedIn('manager@number160.local');
    const other = (await manager.post('/api/v1/vouchers', TERMS)).body.vouchers[0].code;
    const res = await upload(new Agent(server.baseUrl), `/api/v1/public/vouchers/${other}/bill-photos`, Buffer.from('not an image'));
    assert.equal(res.status, 415);
  });

  it('the counter adds a photo when redeeming; merchant roles see it, others do not', async () => {
    const staff = await signedIn('staff@number160.local');
    assert.equal((await staff.post(`/api/v1/vouchers/${code}/redeem`, { grossAmount: '500000' })).status, 200);
    const res = await upload(staff, `/api/v1/vouchers/${code}/bill-photos`, await billJpeg());
    assert.equal(res.status, 201);
    const photos = res.body.voucher.billPhotos;
    assert.deepEqual(photos.map((/** @type {any} */ p) => p.addedBy), ['GUEST', 'GUEST', 'GUEST', 'STAFF']);

    const admin = await signedIn('admin@number160.local');
    const listed = (await admin.get('/api/v1/vouchers')).body.vouchers.find((/** @type {any} */ v) => v.code === code);
    assert.equal(listed.billPhotos.length, 4);
    const image = await fetch(server.baseUrl + photos[3].url, { headers: { cookie: admin.cookie, 'x-forwarded-for': admin.ip } });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/webp');
    assert.match(image.headers.get('cache-control') ?? '', /private/);

    const anonymous = await fetch(server.baseUrl + photos[3].url);
    assert.equal(anonymous.status, 401);
    const otherAdmin = await signedIn('admin@other.local');
    const foreign = await fetch(server.baseUrl + photos[3].url, { headers: { cookie: otherAdmin.cookie, 'x-forwarded-for': otherAdmin.ip } });
    assert.equal(foreign.status, 404);
    assert.equal((await fetch(`${server.baseUrl}/api/v1/files/${photos[3].id}`)).status, 404);
    assert.equal((await upload(otherAdmin, `/api/v1/vouchers/${code}/bill-photos`, await billJpeg())).status, 403);
    assert.equal((await upload(await signedIn('staff@other.local'), `/api/v1/vouchers/${code}/bill-photos`, await billJpeg())).status, 404);
  });

  it('a voided voucher takes no photo', async () => {
    const admin = await signedIn('admin@number160.local');
    const voided = (await admin.post('/api/v1/vouchers', TERMS)).body.vouchers[0].code;
    await admin.post(`/api/v1/vouchers/${voided}/void`, { reason: 'test' });
    const res = await upload(new Agent(server.baseUrl), `/api/v1/public/vouchers/${voided}/bill-photos`, await billJpeg());
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'VOUCHER_VOID');
  });
});
