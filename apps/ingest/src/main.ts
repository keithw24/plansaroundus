// Runs scheduled data loads. `npm start -w @aroundus/ingest [job ...]` runs the
// named jobs, or all of them; deploy runs it daily from cron (README phase 9).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigError, createLogger, loadConfig } from "@aroundus/core";
import { createPgQuery } from "@aroundus/pg";
import type { IngestJob } from "./job.ts";

const JOBS_DIR = join(import.meta.dirname, "jobs");
const JOB_TIMEOUT_MS = 15 * 60_000;

export async function loadJobs(dir = JOBS_DIR): Promise<IngestJob[]> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const jobs: IngestJob[] = [];
  for (const file of files.sort()) {
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as { default?: IngestJob };
    if (!mod.default?.name) throw new Error(`${file} has no default IngestJob export`);
    jobs.push(mod.default);
  }
  return jobs;
}

async function main() {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  }
  const log = createLogger({ level: config.logLevel, base: { app: "ingest" } });
  if (!config.databaseUrl) {
    log.error("DATABASE_URL is required for ingest");
    process.exit(1);
  }

  const wanted = process.argv.slice(2);
  const jobs = (await loadJobs()).filter((j) => wanted.length === 0 || wanted.includes(j.name));
  if (jobs.length === 0) {
    log.error("no matching jobs", { wanted });
    process.exit(1);
  }

  const db = createPgQuery(config.databaseUrl, log);
  let failed = 0;
  for (const job of jobs) {
    const started = Date.now();
    const jobLog = log.child({ job: job.name });
    try {
      const { upserted } = await job.run({
        query: db.query,
        log: jobLog,
        fetch,
        now: new Date(),
        signal: AbortSignal.timeout(JOB_TIMEOUT_MS),
      });
      jobLog.info("job done", { upserted, ms: Date.now() - started });
    } catch (err) {
      failed++;
      jobLog.error("job failed", { err, ms: Date.now() - started });
    }
  }
  await db.close();
  process.exit(failed > 0 ? 1 : 0);
}

if (process.argv[1] === import.meta.filename) await main();
