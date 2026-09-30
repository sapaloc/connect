import { parseArgs } from 'node:util';
import { recordAudit } from '../audit/audit.js';
import { revokeUserSessions } from '../auth/session.js';
import { env, requireEnv } from '../config/env.js';
import { closeClient, collection } from './mongo.js';
import { withTransaction } from './tx.js';

const USAGE = `Usage: pnpm user:block --email <email> --confirm <APP_ENV>
Sets the account to BLOCKED and signs it out everywhere; roles and history are kept.
--confirm must repeat APP_ENV. Targets MONGODB_URI / MONGODB_DB.`;

async function main() {
  const { values } = parseArgs({ options: { email: { type: 'string' }, confirm: { type: 'string' } } });
  const email = values.email?.trim().toLowerCase();
  if (!email || values.confirm !== env.appEnv) {
    console.error(USAGE);
    process.exit(1);
  }

  requireEnv('mongodbUri');
  try {
    const result = await withTransaction(async (session) => {
      const users = await collection('users');
      const user = await users.findOne({ email }, { session, projection: { status: 1 } });
      if (!user) return 'not found';
      if (user.status === 'BLOCKED') return 'already blocked';
      await users.updateOne({ _id: user._id }, { $set: { status: 'BLOCKED', updatedAt: new Date() } }, { session });
      await revokeUserSessions(user._id, { session });
      await recordAudit(
        {
          eventType: 'USER_BLOCKED_BY_SCRIPT',
          entityType: 'user_account',
          entityId: user._id,
          before: { status: user.status },
          after: { status: 'BLOCKED' },
          reason: 'user:block',
        },
        { session },
      );
      return 'blocked';
    });
    console.log(`user:block: ${email} ${result}`);
  } finally {
    await closeClient();
  }
}

await main();
