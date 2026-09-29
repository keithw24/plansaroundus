import {
  type ChatLine,
  createFlags,
  parseFlagSettings,
  silentLogger,
  type TurnInput,
} from "@aroundus/core";
import { describe, expect, it } from "vitest";
import { createIntentPreviewTurn, HELP, WHERE_ARE_YOU, WHERE_TO } from "../src/replies.ts";
import { pin } from "./fakes.ts";

// No LLM: these run on the keyword parser.
const turn = createIntentPreviewTurn(null);
const input = (
  text: string,
  lastLocation: TurnInput["lastLocation"] = null,
  recent: ChatLine[] = [],
) => ({
  text,
  now: new Date(),
  lastLocation,
  recent,
  flags: createFlags(parseFlagSettings({}).settings).forSender(null),
  signal: new AbortController().signal,
  log: silentLogger,
});

describe("intent preview turn", () => {
  it("small talk gets help, with or without a location", async () => {
    expect(await turn(input("hi"))).toBe(HELP);
    expect(await turn(input("hi", pin))).toBe(HELP);
  });

  it("a question with no origin asks where you are", async () => {
    expect(await turn(input("is it safe around me?"))).toBe(WHERE_ARE_YOU);
  });

  it("a named place counts as the origin", async () => {
    expect(await turn(input("cheap ramen near Columbia"))).toBe(
      "Got it: food (ramen, low budget) near Columbia, now. Real answers come in the next build.",
    );
  });

  it("route with no destination asks where to", async () => {
    expect(await turn(input("directions please", pin))).toBe(WHERE_TO);
  });

  it("describes a full plan near the shared pin", async () => {
    expect(await turn(input("plan a fun and safe night", pin))).toBe(
      "Got it: safety + food + events near your shared location, now. Real answers come in the next build.",
    );
  });
});
