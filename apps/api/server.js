import http from 'node:http';
import { env } from './src/config/env.js';
import { handle } from './src/http/app.js';

http.createServer(handle).listen(env.port, () => {
  console.log(`api listening on http://localhost:${env.port} (${env.appEnv})`);
});
