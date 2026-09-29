import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createLlm,
  type Generate,
  type Logger,
  type SenderFlags,
  silentLogger,
} from "@aroundus/core";
import { describe, expect, it, vi } from "vitest";
import {
  INTENT_SYSTEM,
  intentPrompt,
  parseIntent,
  sanitizeIntent,
  type UserIntent,
} from "../src/intent.ts";
import { fixtureKey, type IntentFixture } from "./fixture-key.ts";
import { INTENT_CASES } from "./intent-cases.ts";

// Real Gemini replies, recorded by scripts/record-intents.ts and keyed by the
// full request, so changing the prompt, schema or recent lines misses them.
const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/intent-gemini.json"), "utf8"),
) as IntentFixture;

const allOn: SenderFlags = { enabled: () => true };
const replay: Generate = async (req) => {
  const hit = fixture.replies[fixtureKey(req)];
  if (!hit) throw new Error("no recorded reply for this request: run npm run record:intents");
  return hit.reply;
};

const parse = (text: string, opts: { generate?: Generate; flags?: SenderFlags } = {}) =>
  parseIntent({
    text,
    recent: [],
    flags: opts.flags ?? allOn,
    llm: createLlm(opts.generate ?? replay),
    log: silentLogger,
  });

describe(`gemini intent: routing table (recorded from ${fixture.model})`, () => {
  it.each(INTENT_CASES)("$text", async (c) => {
    const result = await parseIntent({
      text: c.text,
      recent: c.recent ?? [],
      flags: allOn,
      llm: createLlm(replay),
      log: silentLogger,
    });
    expect(result.source).toBe("gemini");
    expect(result.intent.needs).toEqual(c.needs);
    expect(result.intent).toMatchObject({ ...c.fields, ...c.gemini });
    expect(result.locationFromRecent).toBe(c.locationFromRecent ?? false);
  });

  it("every fixture is used by a case, so none are stale", () => {
    const used = new Set(INTENT_CASES.map((c) => c.text));
    const stale = Object.values(fixture.replies).filter((r) => !used.has(r.message));
    expect(stale).toEqual([]);
    expect(Object.keys(fixture.replies)).toHaveLength(INTENT_CASES.length);
  });
});

describe("parseIntent", () => {
  it("sends the system prompt, recent lines and schema to the model", async () => {
    const generate = vi.fn<Generate>(
      async () => '{"needs":[],"when":"now","categories":[],"cuisine":[]}',
    );
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

  it("never throws, even if the flag check does", async () => {
    const broken: SenderFlags = {
      enabled: () => {
        throw new Error("flag boom");
      },
    };
    const result = await parse("good pizza?", { flags: broken });
    expect(result).toMatchObject({ source: "heuristic", intent: { needs: ["food"] } });
  });

  it("logs the failure kind, never the model's or user's words", async () => {
    const lines: unknown[] = [];
    const log: Logger = {
      ...silentLogger,
      warn: (msg, fields) => void lines.push({ msg, fields }),
    };
    await parseIntent({
      text: "my ex lives at 55 Elm St",
      recent: [],
      flags: allOn,
      llm: createLlm(async () => "my ex lives at 55 Elm St, not JSON"),
      log,
    });
    expect(JSON.stringify(lines)).not.toContain("Elm");
    expect(lines).toEqual([
      { msg: "intent: gemini failed, using keywords", fields: { kind: "invalid_json" } },
    ]);
  });
});

describe("sanitizeIntent", () => {
  const base: UserIntent = { needs: [], when: "now", categories: [], cuisine: [] };
  const check = (
    intent: UserIntent,
    text: string,
    recent: Parameters<typeof sanitizeIntent>[2] = [],
  ) => sanitizeIntent(intent, text, recent);

  it("drops places the user never said, so the model can't invent one", () => {
    const { intent } = check(
      {
        ...base,
        needs: ["food"],
        locationQuery: "Columbia University",
        destinationQuery: "Katz's",
      },
      "dinner near columbia",
    );
    expect(intent).not.toHaveProperty("locationQuery");
    expect(intent).not.toHaveProperty("destinationQuery");
  });

  it("never accepts 'here', 'me' or a fragment of a word as a place", () => {
    for (const q of ["here", "me", "Col", "a"]) {
      const { intent } = check(
        { ...base, locationQuery: q },
        "is it safe here near me in Columbia a lot",
      );
      expect(intent).not.toHaveProperty("locationQuery");
    }
  });

  it("matches places across punctuation, apostrophes, accents and case", () => {
    const pairs: [string, string][] = [
      ["St. Marks Place", "drinks on st marks place?"],
      ["Hell's Kitchen", "dinner in hells kitchen"],
      ["Café Lalo", "how do i get to cafe lalo"],
      ["Columbia.", "near Columbia"],
      ["Joe's Pizza", "get to joe’s   pizza"],
    ];
    for (const [q, text] of pairs) {
      expect(check({ ...base, destinationQuery: q }, text).intent.destinationQuery).toBe(q);
    }
  });

  it("keeps places from the user's recent lines, flagged, but never the agent's", () => {
    const recent = [
      { role: "user" as const, text: "dinner near Columbia" },
      { role: "agent" as const, text: "Try Jin Ramen" },
    ];
    const result = check(
      { ...base, locationQuery: "Columbia", destinationQuery: "Jin Ramen" },
      "sushi?",
      recent,
    );
    expect(result.intent.locationQuery).toBe("Columbia");
    expect(result.locationFromRecent).toBe(true);
    expect(result.intent).not.toHaveProperty("destinationQuery");
  });

  it("orders and dedupes needs, cleans lists, defaults when", () => {
    const { intent } = check(
      { ...base, needs: ["route", "safety", "route"], when: " ", cuisine: [" Ramen", "ramen", ""] },
      "x",
    );
    expect(intent).toEqual({ ...base, needs: ["safety", "route"], cuisine: ["ramen"] });
  });
});
