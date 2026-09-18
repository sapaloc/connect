'use strict';
const { Router } = require('express');
const { vnNow } = require('../utils');

function healthRoutes() {
  const r = Router();
  // Railway healthcheck target (see railway.toml)
  r.get('/api/health', (req, res) => res.json({ ok: true, ts: vnNow() }));
  return r;
}

module.exports = { healthRoutes };
