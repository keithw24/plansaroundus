import { describe, expect, it } from "vitest";
import { LlmError } from "../src/llm.ts";
import { createLogger } from "../src/logger.ts";

const capture = (level: "debug" | "info" = "info") => {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({ level, write: (l) => lines.push(JSON.parse(l)) });
  return { log, lines };
};

describe("logger", () => {
  it("filters by level and adds child fields", () => {
    const { log, lines } = capture();
    log.debug("hidden");
    log.child({ skill: "food" }).info("ran", { ms: 12 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "info", msg: "ran", skill: "food", ms: 12 });
  });

  it("fields can't overwrite level, msg or time", () => {
    const { log, lines } = capture();
    log.child({ level: "debug" }).error("real", { msg: "fake", time: "never" });
    expect(lines[0]).toMatchObject({ level: "error", msg: "real" });
    expect(lines[0]?.time).not.toBe("never");
  });

  it("never throws on BigInts or cycles", () => {
    const { log, lines } = capture();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => log.info("odd", { big: 10n, cyclic })).not.toThrow();
    expect(lines[0]).toMatchObject({ big: "10", cyclic: { self: "[seen]" } });
  });

  it("keeps error kind and cause", () => {
    const { log, lines } = capture();
    const err = new LlmError("timeout", "no reply", { cause: new Error("socket hang up") });
    log.error("llm failed", { err });
    expect(lines[0]?.err).toMatchObject({
      name: "LlmError",
      kind: "timeout",
      message: "no reply",
      cause: { message: "socket hang up" },
    });
  });
});
