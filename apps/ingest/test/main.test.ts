import { describe, expect, it } from "vitest";
import { loadJobs } from "../src/main.ts";

describe("ingest", () => {
  it("every file in src/jobs exports a named job", async () => {
    const jobs = await loadJobs();
    expect(new Set(jobs.map((j) => j.name)).size).toBe(jobs.length);
  });
});
