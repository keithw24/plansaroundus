import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Query } from "@aroundus/core";
import { PGlite } from "@electric-sql/pglite";

const SQL_DIR = join(import.meta.dirname, "../../sql");

/**
 * A real Postgres (PGlite, in-process WASM) with every sql/ migration applied,
 * behind core's Query type. For tests of SQL: no server or DATABASE_URL needed.
 * Timescale isn't available here, so migrations guard their hypertable calls
 * (see sql/README.md).
 */
export async function createTestDb(): Promise<{ query: Query; close: () => Promise<void> }> {
  const db = new PGlite();
  const files = readdirSync(SQL_DIR)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort();
  for (const file of files) await db.exec(readFileSync(join(SQL_DIR, file), "utf8"));
  const query: Query = async <Row extends Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ) => (await db.query<Row>(sql, params ? [...params] : [])).rows;
  return { query, close: () => db.close() };
}
