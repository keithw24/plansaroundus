import type { Logger, Query } from "@aroundus/core";

export type IngestContext = {
  query: Query;
  log: Logger;
  /** Injected so tests can serve recorded responses. */
  fetch: typeof fetch;
  now: Date;
  signal: AbortSignal;
};

/**
 * One scheduled data load, e.g. NYPD complaints or city events. Each job is a
 * file in src/jobs/ whose default export is an IngestJob; main.ts finds them.
 * Jobs must be idempotent: upsert by source id, safe to rerun daily.
 */
export type IngestJob = {
  name: string;
  run(ctx: IngestContext): Promise<{ upserted: number }>;
};
