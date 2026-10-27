import type { Logger, Query } from "@aroundus/core";
import pg from "pg";

/**
 * A pg pool behind core's `Query` type. Connects and queries time out, so a
 * stalled database fails a turn instead of hanging it.
 */
export function createPgQuery(
  connectionString: string,
  log: Logger,
): { query: Query; close: () => Promise<void> } {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5_000,
    query_timeout: 8_000,
    statement_timeout: 8_000,
  });
  // Without a listener, an idle client dropping (e.g. a database restart)
  // is an unhandled 'error' event and crashes the process.
  pool.on("error", (err) => log.warn("idle database client failed", { err }));

  const query: Query = async (sql, params) => {
    const result = await pool.query(sql, params ? [...params] : undefined);
    return result.rows;
  };
  return { query, close: () => pool.end() };
}
