import { describe, expect, it } from "vitest";
import { heuristicIntent, MAX_HEURISTIC_CHARS } from "../src/heuristic.ts";
import { sanitizeIntent } from "../src/intent.ts";
import { INTENT_CASES } from "./intent-cases.ts";

describe("heuristic intent: routing table", () => {
  it.each(INTENT_CASES)("$text", ({ text, recent = [], needs, fields, heuristic }) => {
    const { intent } = sanitizeIntent(heuristicIntent(text), text, recent);
    expect(intent.needs).toEqual(needs);
    expect(intent).toMatchObject({ ...fields, ...heuristic });
  });
});

describe("heuristic intent: edge cases", () => {
  it.each([
    "drive safe ❤️",
    "got home safe",
    "play it safe lol",
    "that was a fun night",
    "i have so much to do at work",
    "no way to know",
    "it's freezing outside",
    "food coma",
  ])("small talk %j picks no skill", (text) => {
    expect(heuristicIntent(text).needs).toEqual([]);
  });

  it("keeps the budget and the place apart", () => {
    expect(heuristicIntent("best ramen near me cheap")).toMatchObject({
      budget: "low",
      needs: ["food"],
    });
    expect(heuristicIntent("restaurants near Bryant Park open late")).toMatchObject({
      locationQuery: "Bryant Park",
      openNow: true,
    });
  });

  it("stays fast on pathological whitespace", () => {
    const start = performance.now();
    heuristicIntent(`near${" ".repeat(10_000)}\nx`);
    heuristicIntent(`get to${" ".repeat(10_000)}\nx`);
    heuristicIntent("near ".repeat(5_000));
    expect(performance.now() - start).toBeLessThan(100);
  });

  it("only looks at the first MAX_HEURISTIC_CHARS characters", () => {
    const text = `${"blah ".repeat(MAX_HEURISTIC_CHARS / 5)} is it safe?`;
    expect(heuristicIntent(text).needs).toEqual([]);
  });
});
