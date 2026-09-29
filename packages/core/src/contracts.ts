import { z } from "zod";
import type { Logger } from "./logger.ts";

export const SKILL_NAMES = ["safety", "food", "events", "route"] as const;
export const SkillName = z.enum(SKILL_NAMES);
export type SkillName = z.infer<typeof SkillName>;

export const Budget = z.enum(["free", "low", "medium", "high"]);
export type Budget = z.infer<typeof Budget>;

export const TravelMode = z.enum(["WALK", "TRANSIT", "DRIVE", "BICYCLE"]);
export type TravelMode = z.infer<typeof TravelMode>;

/** ISO 8601 timestamp with an explicit offset, e.g. "2026-09-29T21:00:00-04:00". */
export const Timestamp = z.iso.datetime({ offset: true });

export const Location = z.object({
  label: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type Location = z.infer<typeof Location>;

export const Source = z.object({
  name: z.string().min(1),
  url: z.url().optional(),
  /** When the underlying data was last refreshed. */
  updatedAt: Timestamp.optional(),
});
export type Source = z.infer<typeof Source>;

/**
 * What a skill hands back. `unavailable` carries no data, only a reason the
 * reply can show ("couldn't reach events", "events is turned off right now").
 * `partial` means usable data with something missing, explained in `warnings`.
 */
export type SkillResult<T> =
  | { status: "ok" | "partial"; data: T; sources: Source[]; warnings: string[] }
  | { status: "unavailable"; data: null; reason: string; sources: Source[]; warnings: string[] };

export type SkillStatus = SkillResult<unknown>["status"];

export function unavailable(reason: string, warnings: string[] = []): SkillResult<never> {
  return { status: "unavailable", data: null, reason, sources: [], warnings };
}

export interface SkillContext {
  now: Date;
  signal: AbortSignal;
  log: Logger;
}

export interface Skill<I, O> {
  readonly name: SkillName;
  /** The dispatcher validates raw input with this before `run()`. */
  readonly input: z.ZodType<I>;
  readonly timeoutMs: number;
  run(input: I, ctx: SkillContext): Promise<SkillResult<O>>;
}

const RecommendationBase = z.object({
  /** The only handle Gemini may cite. Stable per source, e.g. "parks:12345". */
  id: z.string().min(1),
  name: z.string().min(1),
  location: Location,
  distanceMeters: z.number().nonnegative(),
  startsAt: Timestamp.optional(),
  endsAt: Timestamp.optional(),
  priceLevel: Budget.optional(),
  openNow: z.boolean().optional(),
  categories: z.array(z.string()),
  url: z.url().optional(),
  source: Source,
});

export const EventRecommendation = RecommendationBase.extend({
  kind: z.literal("event"),
  startsAt: Timestamp,
});
export type EventRecommendation = z.infer<typeof EventRecommendation>;

export const FoodRecommendation = RecommendationBase.extend({
  kind: z.literal("food"),
  /** Google Places id, so routing can always target the exact place. */
  placeId: z.string().min(1),
  rating: z.number().min(0).max(5).optional(),
  /** One-line reason from the re-rank, if it ran. */
  reason: z.string().optional(),
});
export type FoodRecommendation = z.infer<typeof FoodRecommendation>;

/** Anything the reply can recommend. */
export const Recommendation = z.discriminatedUnion("kind", [
  EventRecommendation,
  FoodRecommendation,
]);
export type Recommendation = z.infer<typeof Recommendation>;
