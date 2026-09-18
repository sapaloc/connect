'use strict';
/* Connect backend — slim boot entry (Railway: `npm start` → node server.js).
   All logic lives under src/ (see src/app.js). Run locally: npm install && npm start.
   Persist data on Railway with a volume: set DATA_FILE=/data/data.json (see railway.toml / README). */
const { PORT, HOST, DATA_FILE } = require('./src/config');
const { createApp } = require('./src/app');

const app = createApp();
app.listen(PORT, HOST, () => {
  console.log(`Connect backend on http://${HOST}:${PORT} (data: ${DATA_FILE})`);
});
