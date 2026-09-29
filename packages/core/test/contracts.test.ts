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

  it("rejects non-http links, blank names and events that end before they start", () => {
    const event = {
      id: "parks:1",
      kind: "event",
      name: "Concert",
      location: columbia,
      distanceMeters: 1,
      startsAt: "2026-09-29T19:00:00-04:00",
      categories: [],
      source: parks,
    };
    expect(Recommendation.safeParse(event).success).toBe(true);
    expect(Recommendation.safeParse({ ...event, url: "javascript:alert(1)" }).success).toBe(false);
    expect(Recommendation.safeParse({ ...event, url: "file:///etc/passwd" }).success).toBe(false);
    expect(Recommendation.safeParse({ ...event, name: "   " }).success).toBe(false);
    expect(
      Recommendation.safeParse({ ...event, endsAt: "2026-09-29T18:00:00-04:00" }).success,
    ).toBe(false);
  });

  it("timestamps need an explicit offset", () => {
    const at = (startsAt: string) =>
      Recommendation.safeParse({
        id: "e",
        kind: "event",
        name: "e",
        location: columbia,
        distanceMeters: 0,
        startsAt,
        categories: [],
        source: parks,
      }).success;
    expect(at("2026-09-29T19:00:00Z")).toBe(true);
    expect(at("2026-09-29T19:00:00")).toBe(false);
    expect(at("2026-09-29")).toBe(false);
  });

  it("unavailable results carry a reason and no data", () => {
    const r: SkillResult<{ count: number }> = unavailable("timeout", "no reply in 4000 ms");
    expect(r).toEqual({
      status: "unavailable",
      data: null,
      reason: "timeout",
      detail: "no reply in 4000 ms",
      sources: [],
      warnings: [],
    });
    expect(unavailable("off")).not.toHaveProperty("detail");
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
