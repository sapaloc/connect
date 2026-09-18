'use strict';
/* Shared primitives (no app state). */
const crypto = require('crypto');

function vnNow() { return new Date().toISOString(); }

function uid(p) {
  return (p || 'id') + '_' + crypto.randomBytes(4).toString('hex') + Date.now().toString(36).slice(-4);
}

module.exports = { vnNow, uid };
