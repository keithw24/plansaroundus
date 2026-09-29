import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELP, WHERE_ARE_YOU } from "../src/replies.ts";

// Phase 2's "done when", run against the real entry point.
const main = join(import.meta.dirname, "../src/main.ts");
const run = (stdin: string) =>
  spawnSync(process.execPath, [main], {
    input: stdin,
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: process.env.PATH, INBOX_BATCH_MS: "20", LOG_LEVEL: "error" },
  });

describe("agent in the terminal", () => {
  it("a pasted location then hi gets the help reply", () => {
    const result = run("40.8075,-73.9626\nhi\n");
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(`agent> ${HELP}`);
  });

  it("a question with no location gets asked where you are", () => {
    const result = run("is it safe around me?\n");
    expect(result.stdout.trim()).toBe(`agent> ${WHERE_ARE_YOU}`);
  });

  it("refuses to start with bad config", () => {
    const result = spawnSync(process.execPath, [main], {
      input: "",
      encoding: "utf8",
      env: { PATH: process.env.PATH, FLAGS_OFF: "skill.fod" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown flag "skill.fod"');
  });
});
