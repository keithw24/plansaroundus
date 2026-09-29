import type { Query } from "@aroundus/core";
import pg from "pg";

/** A pg pool behind core's `Query` type. */
export function createPgQuery(connectionString: string): {
  query: Query;
  close: () => Promise<void>;
} {
  const pool = new pg.Pool({ connectionString, max: 5 });
  const query: Query = async (sql, params) => {
    const result = await pool.query(sql, params ? [...params] : undefined);
    return result.rows;
  };
  return { query, close: () => pool.end() };
}
