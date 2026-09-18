'use strict';
/* Central runtime configuration — env-overridable for Railway deployment.
   - PORT: served port (Railway injects PORT automatically)
   - HOST: bind interface (default 0.0.0.0 so Railway routing works)
   - DATA_FILE: full path to file-NoSQL store (mount a Railway volume here for persistence)
   - DATA_DIR: directory containing data.json (alternative to DATA_FILE)
*/
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const DATA_FILE = process.env.DATA_FILE || path.join(DATA_DIR, 'data.json');
// Frontend bundle served statically (same-origin /api/* + UI on one Railway service)
const FRONT_DIR = process.env.FRONT_DIR || path.join(ROOT, 'view');

module.exports = {
  ROOT,
  PORT: Number(process.env.PORT || 3000),
  HOST: process.env.HOST || '0.0.0.0',
  DATA_FILE,
  FRONT_DIR,
  JSON_LIMIT: process.env.JSON_LIMIT || '1mb',
  SESSION_TTL_MS: 8 * 3600 * 1000,
  RATE_WINDOW_MS: 5 * 60 * 1000,
  RATE_MAX: 5,
};
