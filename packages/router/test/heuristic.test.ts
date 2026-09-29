import { describe, expect, it } from "vitest";
import { heuristicIntent } from "../src/heuristic.ts";
import { sanitizeIntent } from "../src/intent.ts";
import { INTENT_CASES } from "./intent-cases.ts";

describe("heuristic intent: routing table", () => {
  it.each(INTENT_CASES)("$text", ({ text, recent = [], needs, fields }) => {
    const intent = sanitizeIntent(heuristicIntent(text), text, recent);
    expect(intent.needs).toEqual(needs);
    if (fields) expect(intent).toMatchObject(fields);
  });
});
