import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { env } from '../config/env.js';

/**
 * Private object storage. STORAGE_DRIVER=supabase (bucket via the Storage REST API, server key only)
 * or local (a folder: STORAGE_ENDPOINT, default .storage). Paths never come from user input.
 * @typedef {{
 *   put(path: string, body: Buffer, contentType: string): Promise<void>,
 *   list(prefix: string): Promise<string[]>,
 *   remove(paths: string[]): Promise<void>,
 * }} Storage
 */

/** @returns {Storage} */
function localStorage() {
  const root = resolve(env.storage.endpoint || '.storage', env.storage.bucket || 'connect-files');
  return {
    async put(path, body) {
      const file = join(root, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, body);
    },
    async list(prefix) {
      const dir = join(root, prefix);
      const names = await readdir(dir).catch(() => []);
      return names.map((name) => `${prefix.replace(/\/$/, '')}/${name}`).sort();
    },
    async remove(paths) {
      await Promise.all(paths.map((path) => rm(join(root, path), { force: true })));
    },
  };
}

/** @returns {Storage} */
function supabaseStorage() {
  const { endpoint, bucket, key } = env.storage;
  if (!endpoint || !bucket || !key) throw new Error('Missing required env: STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_KEY');
  const base = `${endpoint.replace(/\/$/, '')}/storage/v1/object`;
  const headers = { authorization: `Bearer ${key}`, apikey: key };

  /** @param {Response} res @param {string} action */
  async function ensureOk(res, action) {
    if (!res.ok) throw new Error(`storage ${action} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  return {
    async put(path, body, contentType) {
      const res = await fetch(`${base}/${bucket}/${path}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': contentType, 'x-upsert': 'true' },
        body,
      });
      await ensureOk(res, 'upload');
    },
    async list(prefix) {
      const folder = prefix.replace(/\/$/, '');
      const res = await fetch(`${base}/list/${bucket}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ prefix: folder, limit: 1000, sortBy: { column: 'name', order: 'asc' } }),
      });
      await ensureOk(res, 'list');
      const items = /** @type {{ name: string, id: string | null }[]} */ (await res.json());
      return items.filter((item) => item.id).map((item) => `${folder}/${item.name}`);
    },
    async remove(paths) {
      if (!paths.length) return;
      const res = await fetch(`${base}/${bucket}`, {
        method: 'DELETE',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ prefixes: paths }),
      });
      await ensureOk(res, 'delete');
    },
  };
}

/** @returns {Storage} */
export function getStorage() {
  if (env.storage.driver === 'supabase') return supabaseStorage();
  if (env.storage.driver === 'local') return localStorage();
  throw new Error(`Unknown STORAGE_DRIVER "${env.storage.driver}" (local or supabase)`);
}
