import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLlm, type Generate, type SenderFlags, silentLogger } from "@aroundus/core";
import { describe, expect, it, vi } from "vitest";
import {
  INTENT_SYSTEM,
  intentPrompt,
  parseIntent,
  sanitizeIntent,
  type UserIntent,
} from "../src/intent.ts";
import { INTENT_CASES } from "./intent-cases.ts";

// Real Gemini replies, recorded by scripts/record-intents.ts.
const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/intent-gemini.json"), "utf8"),
) as { model: string; replies: Record<string, string> };

const allOn: SenderFlags = { enabled: () => true };
const replay: Generate = async ({ prompt }) => {
  const text = /Message: (.*)$/s.exec(prompt)?.[1] ?? "";
  const reply = fixture.replies[text];
  if (reply === undefined) throw new Error(`no recorded reply for "${text}"`);
  return reply;
};

const parse = (
  text: string,
  opts: { generate?: Generate; flags?: SenderFlags; recent?: [] } = {},
) =>
  parseIntent({
    text,
    recent: opts.recent ?? [],
    flags: opts.flags ?? allOn,
    llm: createLlm(opts.generate ?? replay),
    log: silentLogger,
  });

describe(`gemini intent: routing table (recorded from ${fixture.model})`, () => {
  it.each(INTENT_CASES)("$text", async ({ text, recent = [], needs, fields, bothPaths }) => {
    const result = await parseIntent({
      text,
      recent,
      flags: allOn,
      llm: createLlm(replay),
      log: silentLogger,
    });
    expect(result.source).toBe("gemini");
    expect(result.intent.needs).toEqual(needs);
    if (fields && bothPaths) expect(result.intent).toMatchObject(fields);
  });
});

describe("parseIntent fallbacks", () => {
  it("sends the system prompt, recent lines and schema to the model", async () => {
    const generate = vi.fn<Generate>(replay);
    const recent = [{ role: "user" as const, text: "where should we get dinner near Columbia" }];
    await parseIntent({
      text: "what about sushi instead?",
      recent,
      flags: allOn,
      llm: createLlm(generate),
      log: silentLogger,
    });
    const req = generate.mock.calls[0]?.[0];
    expect(req?.system).toBe(INTENT_SYSTEM);
    expect(req?.prompt).toBe(intentPrompt("what about sushi instead?", recent));
    expect(req?.prompt).toContain("user: where should we get dinner near Columbia");
    expect(req?.jsonSchema).toMatchObject({ properties: { needs: { type: "array" } } });
  });

  it("uses keywords when intent.gemini is off, without calling the model", async () => {
    const generate = vi.fn<Generate>(replay);
    const off: SenderFlags = { enabled: (name) => name !== "intent.gemini" };
    const result = await parse("Is it safe around me?", { generate, flags: off });
    expect(result).toMatchObject({
      source: "heuristic",
      fallback: "flag_off",
      intent: { needs: ["safety"] },
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("uses keywords when there's no Gemini key", async () => {
    const result = await parseIntent({
      text: "good pizza?",
      recent: [],
      flags: allOn,
      llm: null,
      log: silentLogger,
    });
    expect(result).toMatchObject({
      source: "heuristic",
      fallback: "no_llm",
      intent: { needs: ["food"] },
    });
  });

  it("an empty message (a pin alone) needs nothing and skips the model", async () => {
    const generate = vi.fn<Generate>(replay);
    const result = await parse("  ", { generate });
    expect(result).toMatchObject({ fallback: "empty", intent: { needs: [] } });
    expect(generate).not.toHaveBeenCalled();
  });

  const failing: [string, Generate, string][] = [
    ["a 503", async () => Promise.reject(new Error("503 UNAVAILABLE")), "provider"],
    ["prose instead of JSON", async () => "Sure! You want food.", "invalid_json"],
    ["a reply off the schema", async () => '{"needs":["pizza"],"when":"now"}', "invalid_output"],
  ];
  it.each(failing)("falls back to keywords on %s", async (_label, generate, kind) => {
    const result = await parse("Where should we get dinner?", { generate });
    expect(result).toMatchObject({
      source: "heuristic",
      fallback: kind,
      intent: { needs: ["food"] },
    });
  });

  it("falls back to keywords on a timeout", async () => {
    const result = await parseIntent({
      text: "How do I get to Jin Ramen?",
      recent: [],
      flags: allOn,
      llm: createLlm(() => new Promise(() => {})),
      log: silentLogger,
      timeoutMs: 20,
    });
    expect(result).toMatchObject({
      fallback: "timeout",
      intent: { needs: ["route"], destinationQuery: "Jin Ramen" },
    });
  });
});

describe("sanitizeIntent", () => {
  const base: UserIntent = { needs: [], when: "now", categories: [], cuisine: [] };

  it("drops places the user never said, so the model can't invent one", () => {
    const intent = sanitizeIntent(
      {
        ...base,
        needs: ["food"],
        locationQuery: "Columbia University",
        destinationQuery: "Katz's",
      },
      "dinner near columbia",
      [],
    );
    expect(intent).not.toHaveProperty("locationQuery");
    expect(intent).not.toHaveProperty("destinationQuery");
  });

  it("keeps places from the user's recent lines but not the agent's", () => {
    const recent = [
      { role: "user" as const, text: "dinner near Columbia" },
      { role: "agent" as const, text: "Try Jin Ramen" },
    ];
    const intent = sanitizeIntent(
      { ...base, locationQuery: "Columbia", destinationQuery: "Jin Ramen" },
      "what about sushi?",
      recent,
    );
    expect(intent.locationQuery).toBe("Columbia");
    expect(intent).not.toHaveProperty("destinationQuery");
  });

  it("orders and dedupes needs, cleans lists, defaults when", () => {
    const intent = sanitizeIntent(
      { ...base, needs: ["route", "safety", "route"], when: " ", cuisine: [" Ramen", "ramen", ""] },
      "x",
      [],
    );
    expect(intent).toEqual({ ...base, needs: ["safety", "route"], cuisine: ["ramen"] });
  });

  it("matches places across curly quotes and spacing", () => {
    const intent = sanitizeIntent(
      { ...base, destinationQuery: "Joe's Pizza" },
      "get to joe’s   pizza",
      [],
    );
    expect(intent.destinationQuery).toBe("Joe's Pizza");
  });
});
