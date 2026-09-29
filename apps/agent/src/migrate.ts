import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const SQL_DIR = join(import.meta.dirname, "../../../sql");
// Any constant works; it just has to be the same for every deploy.
const LOCK_ID = 7_140_917;

/**
 * Applies sql/NNN_*.sql files not yet in app.migrations, in order, each in its
 * own transaction. An advisory lock stops two deploys migrating at once.
 * Files are still written additive and idempotent, per the build plan.
 */
export async function migrate(connectionString: string, log: (line: string) => void = console.log) {
  const files = readdirSync(SQL_DIR)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort();
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(`create schema if not exists app;
      create table if not exists app.migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`);
    const done = new Set(
      (await client.query<{ name: string }>("select name from app.migrations")).rows.map(
        (r) => r.name,
      ),
    );
    for (const file of files) {
      if (done.has(file)) continue;
      await client.query("begin");
      try {
        await client.query(readFileSync(join(SQL_DIR, file), "utf8"));
        await client.query("insert into app.migrations (name) values ($1)", [file]);
        await client.query("commit");
        log(`applied ${file}`);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`migration ${file} failed`, { cause: err });
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    await client.end();
  }
}

// Run directly (npm run migrate), not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  await migrate(url);
}
