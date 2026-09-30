import { detectImageType, FILE_ASSET_MAX_BYTES, LOGO_UPLOAD_MAX_BYTES } from '#domain';
import { Binary } from 'mongodb';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { collection } from '../db/mongo.js';
import { HttpError } from '../http/errors.js';
import { sendError } from '../http/respond.js';

/** Resize and WebP settings per asset type (plan §21.3). */
const WEBP = /** @type {const} */ ({
  BRAND_LOGO: { maxSide: 512, quality: 85 },
  PAYMENT_RECEIPT: { maxSide: 1600, quality: 80 },
});
/** Asset types anyone may read (shown on public pages). */
const PUBLIC_TYPES = ['BRAND_LOGO'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Raw request body, capped. Vercel may hand the body over already buffered.
 * @param {import('node:http').IncomingMessage & { body?: unknown }} req
 * @param {number} [max]
 */
export async function readBinary(req, max = LOGO_UPLOAD_MAX_BYTES) {
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length > max) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The file is too large');
    return req.body;
  }
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > max) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The file is too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The file is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * JPEG / PNG / WebP (checked by magic bytes) -> WebP, rotated by EXIF, metadata stripped, never enlarged.
 * HEIC is converted by the browser before upload; the server build of sharp cannot decode it.
 * @param {Buffer} input
 * @param {keyof typeof WEBP} assetType
 */
export async function imageAsset(input, assetType) {
  const type = detectImageType(input);
  if (type === 'heic') throw new HttpError(415, 'IMAGE_HEIC_UNSUPPORTED', 'HEIC must be converted before upload');
  if (!type) throw new HttpError(415, 'IMAGE_TYPE_INVALID', 'Only JPEG, PNG or WebP images are accepted');
  const { maxSide, quality } = WEBP[assetType];
  let output;
  try {
    output = await sharp(input, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .webp({ quality, alphaQuality: 100 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new HttpError(415, 'IMAGE_TYPE_INVALID', 'The image could not be read');
  }
  if (output.data.length > FILE_ASSET_MAX_BYTES) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The converted image is above 1 MB');
  return {
    _id: randomUUID(),
    assetType,
    data: new Binary(output.data),
    mimeType: 'image/webp',
    width: output.info.width,
    height: output.info.height,
    byteSize: output.data.length,
    originalByteSize: input.length,
    checksumSha256: createHash('sha256').update(output.data).digest('hex'),
    status: 'ACTIVE',
    createdAt: new Date(),
    replacedAt: null,
  };
}

/** @param {string | null | undefined} assetId */
export function fileUrl(assetId) {
  return assetId ? `/api/v1/files/${assetId}` : null;
}

/**
 * Image behind a sign-in check (e.g. a bill photo): cached by this browser only.
 * @param {import('node:http').ServerResponse} res
 * @param {any} asset
 */
export function sendPrivateAsset(res, asset) {
  const body = Buffer.from(asset.data.buffer);
  res.statusCode = 200;
  res.setHeader('Content-Type', asset.mimeType);
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.end(body);
}

/**
 * Public images only while ACTIVE; the id changes on every upload, so the response is immutable.
 * `?format=png` converts on the fly for apps that handle WebP poorly (plan §21.3).
 * @type {import('../http/router.js').Handler}
 */
async function serveFile(req, res, ctx) {
  const id = ctx.params.id.toLowerCase();
  const files = await collection('fileAssets');
  const asset = UUID_PATTERN.test(id) ? await files.findOne({ _id: id, status: 'ACTIVE', assetType: { $in: PUBLIC_TYPES } }) : null;
  if (!asset) {
    sendError(res, 404, 'FILE_NOT_FOUND', 'File not found');
    return;
  }
  const png = new URL(req.url ?? '/', 'http://localhost').searchParams.get('format') === 'png';
  const etag = `"${asset.checksumSha256}${png ? '-png' : ''}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  const body = png ? await sharp(asset.data.buffer).png().toBuffer() : Buffer.from(asset.data.buffer);
  res.statusCode = 200;
  res.setHeader('Content-Type', png ? 'image/png' : asset.mimeType);
  res.setHeader('Content-Length', String(body.length));
  res.end(body);
}

/** @type {import('../http/router.js').RouteDef[]} */
export const fileRoutes = [{ method: 'GET', path: '/api/v1/files/:id', handler: serveFile }];
