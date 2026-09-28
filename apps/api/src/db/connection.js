const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Supabase requires TLS; local Postgres usually has none. `sslmode` in the URL
 * would override the `ssl` option in node-postgres, so it is stripped here.
 * @param {string} connectionString
 */
export function connectionConfig(connectionString) {
  const url = new URL(connectionString);
  url.searchParams.delete('sslmode');
  const isLocal = LOCAL_HOSTS.has(url.hostname);
  return {
    connectionString: url.toString(),
    ssl: isLocal ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000,
  };
}
