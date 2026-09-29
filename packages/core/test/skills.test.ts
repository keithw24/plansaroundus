import { describe, expect, expectTypeOf, it } from "vitest";
import type { Location } from "../src/contracts.ts";
import { EventsInput, RouteData, SKILL_IO, type SkillRegistry } from "../src/skills.ts";

const columbia: Location = { label: "Columbia", latitude: 40.8075, longitude: -73.9626 };

describe("skill io", () => {
  it("has a schema pair for every skill", () => {
    expect(Object.keys(SKILL_IO).sort()).toEqual(["events", "food", "route", "safety"]);
  });

  it("fills event defaults", () => {
    const input = EventsInput.parse({
      origin: columbia,
      from: "2026-09-29T18:00:00-04:00",
      to: "2026-09-29T23:59:00-04:00",
    });
    expect(input).toMatchObject({ radiusMeters: 2000, categories: [], webEnrichment: false });
  });

  it("route data may omit a duration but always has an http link", () => {
    expect(
      RouteData.safeParse({ travelMode: "WALK", directionsUrl: "https://maps.google.com/x" })
        .success,
    ).toBe(true);
    expect(RouteData.safeParse({ travelMode: "WALK", directionsUrl: "maps://x" }).success).toBe(
      false,
    );
  });

  it("the registry ties each name to its own types", () => {
    expectTypeOf<SkillRegistry["route"]["name"]>().toEqualTypeOf<"route">();
    expectTypeOf<Parameters<SkillRegistry["safety"]["run"]>[0]>().toHaveProperty("hourEt");
  });
});
