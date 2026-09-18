'use strict';
/* Express wiring: JSON body, CORS, API routers (fixed order), static UI, SPA fallback.
   Route order matters: specific GETs (site/settings) are registered inside
   snapshotRoutes() BEFORE the generic /api/:col handler. */
const express = require('express');
const cors = require('cors');
const path = require('path');
const { FRONT_DIR, JSON_LIMIT } = require('./config');
const { autoEnd } = require('./db/store');
const { healthRoutes } = require('./routes/health');
const { authRoutes } = require('./routes/auth');
const { snapshotRoutes } = require('./routes/snapshot');
const { partnerRoutes } = require('./routes/partners');
const { locationRoutes } = require('./routes/locations');
const { referrerRoutes } = require('./routes/referrers');
const { budgetRoutes } = require('./routes/budgets');
const { mediaRoutes } = require('./routes/media');
const { cardRoutes } = require('./routes/cards');
const { voucherRoutes } = require('./routes/vouchers');
const { counterRoutes } = require('./routes/counter');
const { voidRoutes } = require('./routes/voids');
const { payoutRoutes } = require('./routes/payouts');
const { settlementRoutes } = require('./routes/settlements');
const { catalogRoutes } = require('./routes/catalog');
const { reportRoutes } = require('./routes/reports');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: JSON_LIMIT }));

  // Scheduled relationship end-date processing (hourly) + once at boot
  autoEnd();
  setInterval(autoEnd, 60 * 60 * 1000);

  // Public + anonymous surface first
  app.use(healthRoutes());
  app.use(voucherRoutes());

  // Authenticated API
  app.use(authRoutes());
  app.use(snapshotRoutes());
  app.use(partnerRoutes());
  app.use(locationRoutes());
  app.use(referrerRoutes());
  app.use(budgetRoutes());
  app.use(mediaRoutes());
  app.use(cardRoutes());
  app.use(counterRoutes());
  app.use(voidRoutes());
  app.use(payoutRoutes());
  app.use(settlementRoutes());
  app.use(catalogRoutes());
  app.use(reportRoutes());

  // Frontend bundle (same-origin UI + API on one Railway service)
  app.use(express.static(FRONT_DIR));
  // SPA fallback — must stay AFTER all /api/* routers
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(FRONT_DIR, 'index.html'));
  });

  return app;
}

module.exports = { createApp };
