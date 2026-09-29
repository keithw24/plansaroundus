import { z } from "zod";
import {
  Budget,
  EventRecommendation,
  FoodRecommendation,
  HttpUrl,
  Location,
  type Skill,
  type SkillName,
  Timestamp,
  TravelMode,
} from "./contracts.ts";

// Each skill's input and output. The router builds inputs and reads outputs
// through these; each skill package implements against them.

const Hour = z.number().int().min(0).max(23);
const Count = z.number().int().nonnegative();

export const SafetyInput = z.object({
  origin: Location,
  /** Hour of day in America/New_York, 0–23. */
  hourEt: Hour,
});
export const SafetyData = z.object({
  radiusMeters: z.number().positive(),
  windowDays: z.number().int().positive(),
  /** Complaints within the radius over the whole window. */
  areaCount: Count,
  /** Of those, how many happened in `hourEt`. */
  hourCount: Count,
  /** areaCount / 24, to compare hourCount against. */
  typicalHourCount: z.number().nonnegative(),
  /** Busiest hour, or null when there are no complaints. */
  peakHour: Hour.nullable(),
  topOffenses: z.array(z.object({ offense: z.string(), count: Count })).max(3),
  /** Newest complaint date in the data. */
  dataThrough: z.iso.date(),
});

export const EventsInput = z
  .object({
    origin: Location,
    from: Timestamp,
    to: Timestamp,
    radiusMeters: z.number().positive().default(2000),
    categories: z.array(z.string()).default([]),
    budget: Budget.optional(),
    /** events.tavily flag, resolved per sender. Required so the caller can't forget it. */
    webEnrichment: z.boolean(),
  })
  .refine((e) => Date.parse(e.to) >= Date.parse(e.from), {
    message: "to is before from",
    path: ["to"],
  });
export const EventsData = z.object({ events: z.array(EventRecommendation).max(5) });

export const FoodInput = z.object({
  origin: Location,
  cuisine: z.array(z.string()).default([]),
  budget: Budget.optional(),
  openNow: z.boolean().default(false),
  /** The user's original words, for the re-rank. */
  request: z.string(),
  /** food.gemini_rank flag, resolved per sender. Required so the caller can't forget it. */
  rerank: z.boolean(),
});
export const FoodData = z.object({ places: z.array(FoodRecommendation).max(5) });

export const RouteInput = z.object({
  origin: Location,
  destination: Location.extend({ placeId: z.string().optional() }),
  travelMode: TravelMode,
  departureTime: Timestamp,
});
export const RouteData = z.object({
  travelMode: TravelMode,
  /** Absent when Routes failed or isn't configured: never guess a time. */
  durationMinutes: z.number().int().nonnegative().optional(),
  distanceMeters: z.number().nonnegative().optional(),
  /** Short transit summary, e.g. "1 train to 116 St". */
  summary: z.string().optional(),
  directionsUrl: HttpUrl,
});

export const SKILL_IO = {
  safety: { input: SafetyInput, data: SafetyData },
  events: { input: EventsInput, data: EventsData },
  food: { input: FoodInput, data: FoodData },
  route: { input: RouteInput, data: RouteData },
} as const satisfies Record<SkillName, { input: z.ZodType; data: z.ZodType }>;

/** What the skill receives, after defaults are applied. */
export type SkillInput<K extends SkillName> = z.output<(typeof SKILL_IO)[K]["input"]>;
/** What the caller may pass, before defaults. */
export type SkillInputRaw<K extends SkillName> = z.input<(typeof SKILL_IO)[K]["input"]>;
export type SkillData<K extends SkillName> = z.output<(typeof SKILL_IO)[K]["data"]>;

export type SafetyInput = SkillInput<"safety">;
export type SafetyData = SkillData<"safety">;
export type EventsInput = SkillInput<"events">;
export type EventsData = SkillData<"events">;
export type FoodInput = SkillInput<"food">;
export type FoodData = SkillData<"food">;
export type RouteInput = SkillInput<"route">;
export type RouteData = SkillData<"route">;

/** One skill per name, each typed to its own input and output. */
export type SkillRegistry = {
  [K in SkillName]: Skill<SkillInput<K>, SkillData<K>> & { readonly name: K };
};
