import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { collection } from '../src/db/mongo.js';
import { Agent, resetDatabase, startServer } from './helpers.js';

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server;
/** @type {Agent} */
let admin;

before(async () => {
  await resetDatabase();
  server = await startServer();
  admin = new Agent(server.baseUrl);
  assert.equal((await admin.login('admin@number160.local')).status, 200);
});

after(async () => {
  await server?.close();
});

/**
 * @param {Agent} agent
 * @param {string} path
 * @param {Buffer} body
 * @param {string} [type]
 */
async function upload(agent, path, body, type = 'application/octet-stream') {
  const res = await fetch(agent.baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': type, cookie: agent.cookie, 'x-forwarded-for': agent.ip },
    body,
  });
  return { status: res.status, body: await res.json() };
}

/** A 2000×1000 PNG with transparency, like a logo exported from a design tool. */
function pngLogo() {
  return sharp({ create: { width: 2000, height: 1000, channels: 4, background: { r: 23, g: 38, b: 45, alpha: 0.5 } } })
    .png()
    .toBuffer();
}

describe('merchant logo', () => {
  /** @type {string} */
  let firstUrl;

  it('a PNG is stored as WebP, at most 512 px, and served publicly with a long cache', async () => {
    const res = await upload(admin, '/api/v1/merchant/logo', await pngLogo());
    assert.equal(res.status, 200);
    firstUrl = res.body.brand.logoUrl;
    assert.match(firstUrl, /^\/api\/v1\/files\/[0-9a-f-]{36}$/);

    const files = await collection('fileAssets');
    const asset = await files.findOne({ assetType: 'BRAND_LOGO', status: 'ACTIVE' });
    assert.equal(asset?.mimeType, 'image/webp');
    assert.deepEqual([asset?.width, asset?.height], [512, 256]);
    assert.ok(/** @type {number} */ (asset?.byteSize) <= 1024 * 1024);

    const served = await fetch(server.baseUrl + firstUrl);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/webp');
    assert.match(served.headers.get('cache-control') ?? '', /immutable/);
    const png = await fetch(`${server.baseUrl}${firstUrl}?format=png`);
    assert.equal(png.headers.get('content-type'), 'image/png');
  });

  it('refuses a file that is not an image, whatever its Content-Type says', async () => {
    const res = await upload(admin, '/api/v1/merchant/logo', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), 'image/png');
    assert.equal(res.status, 415);
    assert.equal(res.body.error.code, 'IMAGE_TYPE_INVALID');
    const gif = await upload(admin, '/api/v1/merchant/logo', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64)]));
    assert.equal(gif.status, 415);
  });

  it('refuses a file above 4 MB before converting it', async () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4 * 1024 * 1024)]);
    const res = await upload(admin, '/api/v1/merchant/logo', big);
    assert.equal(res.status, 413);
  });

  it('a new logo replaces the old one; the old file is no longer served', async () => {
    const jpeg = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#F26A3D' } }).jpeg().toBuffer();
    const res = await upload(admin, '/api/v1/merchant/logo', jpeg);
    assert.equal(res.status, 200);
    assert.notEqual(res.body.brand.logoUrl, firstUrl);
    assert.equal((await fetch(server.baseUrl + firstUrl)).status, 404);
    assert.equal((await fetch(server.baseUrl + res.body.brand.logoUrl)).status, 200);
    const files = await collection('fileAssets');
    assert.equal(await files.countDocuments({ assetType: 'BRAND_LOGO', status: 'REPLACED' }), 1);
  });

  it('Manager cannot change the logo; Platform admin can replace it for a merchant', async () => {
    const manager = new Agent(server.baseUrl);
    await manager.login('manager@number160.local');
    assert.equal((await upload(manager, '/api/v1/merchant/logo', await pngLogo())).status, 403);

    const platform = new Agent(server.baseUrl);
    await platform.login('platform@connect.local');
    const merchants = await platform.get('/api/v1/merchants');
    const number160 = merchants.body.merchants.find((/** @type {any} */ m) => m.name === 'Number160');
    assert.ok(number160.brand.logoUrl);
    const res = await upload(platform, `/api/v1/merchants/${number160.id}/logo`, await pngLogo());
    assert.equal(res.status, 200);
    assert.notEqual(res.body.brand.logoUrl, number160.brand.logoUrl);
  });
});

describe('brand colour', () => {
  it('stores a readable colour and picks the text colour; refuses low contrast', async () => {
    const res = await admin.post('/api/v1/merchant/brand', { brandColor: '#17262d' });
    assert.equal(res.status, 200);
    assert.equal(res.body.brand.color, '#17262D');
    assert.equal(res.body.brand.textColor, '#FFFFFF');
    const grey = await admin.post('/api/v1/merchant/brand', { brandColor: '#7A7A7A' });
    assert.equal(grey.status, 422);
    assert.equal(grey.body.error.code, 'BRAND_COLOR_LOW_CONTRAST');
    assert.equal((await admin.post('/api/v1/merchant/brand', { brandColor: 'orange' })).body.error.code, 'BRAND_COLOR_INVALID');
  });

  it('logo and colour appear on the public voucher page', async () => {
    const manager = new Agent(server.baseUrl);
    await manager.login('manager@number160.local');
    const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const issued = await manager.post('/api/v1/vouchers', { discountType: 'PERCENT', discountValue: '10', validUntil: date });
    const code = issued.body.vouchers[0].code;
    const res = await new Agent(server.baseUrl).get(`/api/v1/public/vouchers/${code}`);
    assert.equal(res.body.voucher.brand.color, '#17262D');
    assert.match(res.body.voucher.brand.logoUrl, /^\/api\/v1\/files\//);
  });

  it('removing the logo keeps the colour', async () => {
    const res = await admin.post('/api/v1/merchant/logo/remove');
    assert.equal(res.status, 200);
    assert.equal(res.body.brand.logoUrl, null);
    assert.equal(res.body.brand.color, '#17262D');
    const settings = await admin.get('/api/v1/merchant/settings');
    assert.equal(settings.body.brand.logoUrl, null);
  });
});
