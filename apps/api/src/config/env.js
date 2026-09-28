const source = process.env;

const names = {
  appOrigin: 'APP_ORIGIN',
  micrositePublicBaseUrl: 'MICROSITE_PUBLIC_BASE_URL',
  databaseUrl: 'DATABASE_URL',
  databaseMigrationUrl: 'DATABASE_MIGRATION_URL',
  sessionSecret: 'SESSION_SECRET',
  internalJobSecret: 'INTERNAL_JOB_SECRET',
};

export const env = Object.freeze({
  appEnv: source.APP_ENV || 'local',
  appOrigin: source.APP_ORIGIN || '',
  micrositePublicBaseUrl: source.MICROSITE_PUBLIC_BASE_URL || '',
  port: Number(source.PORT || 3000),
  databaseUrl: source.DATABASE_URL || '',
  databaseMigrationUrl: source.DATABASE_MIGRATION_URL || '',
  dbPoolMax: Number(source.DB_POOL_MAX || 5),
  sessionSecret: source.SESSION_SECRET || '',
  internalJobSecret: source.INTERNAL_JOB_SECRET || '',
  storage: Object.freeze({
    driver: source.STORAGE_DRIVER || 'local',
    bucket: source.STORAGE_BUCKET || '',
    endpoint: source.STORAGE_ENDPOINT || '',
    key: source.STORAGE_KEY || '',
  }),
  logLevel: source.LOG_LEVEL || 'info',
  commitSha: source.VERCEL_GIT_COMMIT_SHA || source.GITHUB_SHA || '',
});

/** @param {...keyof typeof names} keys */
export function requireEnv(...keys) {
  const missing = keys.filter((key) => !env[key]).map((key) => names[key]);
  if (missing.length) {
    throw new Error(`Missing required env: ${missing.join(', ')}`);
  }
}
