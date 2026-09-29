import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  type Location,
  Recommendation,
  type Skill,
  type SkillResult,
  unavailable,
} from "../src/contracts.ts";
import { silentLogger } from "../src/logger.ts";

const columbia: Location = { label: "Columbia", latitude: 40.8075, longitude: -73.9626 };
const parks = { name: "NYC Parks", url: "https://www.nycgovparks.org/events" };

describe("contracts", () => {
  it("parses event and food recommendations by kind", () => {
    const event = Recommendation.parse({
      id: "parks:123",
      kind: "event",
      name: "Movies Under the Stars",
      location: columbia,
      distanceMeters: 400,
      startsAt: "2026-09-29T19:30:00-04:00",
      categories: ["film"],
      source: parks,
    });
    expect(event.kind).toBe("event");

    const food = Recommendation.parse({
      id: "places:abc",
      kind: "food",
      placeId: "abc",
      name: "Jin Ramen",
      location: columbia,
      distanceMeters: 650,
      priceLevel: "low",
      categories: ["ramen"],
      source: { name: "Google Places" },
    });
    expect(food.kind === "food" && food.placeId).toBe("abc");
  });

  it("rejects an event with no start, a food pick with no placeId, and bad coordinates", () => {
    const common = { id: "x", name: "x", distanceMeters: 1, categories: [], source: parks };
    expect(Recommendation.safeParse({ ...common, kind: "event", location: columbia }).success).toBe(
      false,
    );
    expect(Recommendation.safeParse({ ...common, kind: "food", location: columbia }).success).toBe(
      false,
    );
    expect(
      Recommendation.safeParse({
        ...common,
        kind: "food",
        placeId: "p",
        location: { ...columbia, latitude: 140 },
      }).success,
    ).toBe(false);
  });

  it("unavailable results carry a reason and no data", () => {
    const r: SkillResult<{ count: number }> = unavailable("couldn't reach safety");
    expect(r).toEqual({
      status: "unavailable",
      data: null,
      reason: "couldn't reach safety",
      sources: [],
      warnings: [],
    });
    if (r.status !== "unavailable") expectTypeOf(r.data).toEqualTypeOf<{ count: number }>();
  });

  it("a skill can be written against the contract", async () => {
    const Input = z.object({ origin: z.custom<Location>() });
    const skill: Skill<z.infer<typeof Input>, { label: string }> = {
      name: "safety",
      input: Input,
      timeoutMs: 100,
      run: async (input) => ({
        status: "ok",
        data: { label: input.origin.label },
        sources: [],
        warnings: [],
      }),
    };
    const result = await skill.run(
      { origin: columbia },
      { now: new Date(), signal: new AbortController().signal, log: silentLogger },
    );
    expect(result.data).toEqual({ label: "Columbia" });
  });
});
