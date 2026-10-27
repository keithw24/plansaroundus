// The food skill (README section 8): Places Text Search, then an optional
// Gemini re-rank by candidate id. Returns the top 5 as FoodData.
import { FoodInput, type Llm, LlmError, type SkillRegistry } from "@aroundus/core";
import { PLACES_SOURCE, PLACES_TIMEOUT_MS, searchPlaces } from "./places.ts";
import { applyRanking, RERANK_TIMEOUT_MS, type RerankContext, rerank } from "./rerank.ts";

export {
  budgetFit,
  budgetFromPriceLevel,
  PLACES_FIELD_MASK,
  PLACES_SEARCH_URL,
  PlacesError,
  searchBody,
  textQuery,
} from "./places.ts";
export {
  applyRanking,
  formatDistance,
  RERANK_SYSTEM,
  RERANK_TIMEOUT_MS,
  RerankReply,
  reasonFor,
  rerankPrompt,
  WHY_CODES,
} from "./rerank.ts";

export const MAX_PLACES = 5;
/** The whole skill's budget: Places, then the re-rank in whatever time is left. */
export const FOOD_TIMEOUT_MS = 9000;
/** Kept back from the deadline so the skill returns before the dispatcher gives up. */
export const DEADLINE_MARGIN_MS = 750;
/** Below this, a re-rank can't usefully finish, so it's skipped. */
export const MIN_RERANK_MS = 1000;

export const RERANK_FAILED_WARNING = "Couldn't re-rank restaurants; showing Google's order.";

export type FoodSkillOptions = {
  /** Required: without a Maps key the router leaves this skill out of the registry. */
  mapsKey: string;
  /** Optional: without one, results keep Places' order. */
  llm?: Llm | null;
  fetch?: typeof fetch;
  /** For tests: milliseconds now. */
  clock?: () => number;
};

export function createFoodSkill(opts: FoodSkillOptions): SkillRegistry["food"] {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const llm = opts.llm ?? null;
  const clock = opts.clock ?? Date.now;
  return {
    name: "food",
    input: FoodInput,
    timeoutMs: FOOD_TIMEOUT_MS,
    async run(input, ctx) {
      const started = clock();
      const search = await searchPlaces({
        mapsKey: opts.mapsKey,
        fetch: doFetch,
        origin: input.origin,
        cuisine: input.cuisine,
        budget: input.budget,
        openNow: input.openNow,
        signal: ctx.signal,
        timeoutMs: PLACES_TIMEOUT_MS,
      });
      // Counts only: the user's request text is never logged.
      ctx.log.info("places search", {
        candidates: search.candidates.length,
        malformed: search.malformed,
        filtered: search.filtered,
        ms: clock() - started,
      });

      let places = search.candidates;
      const warnings: string[] = [];
      if (input.rerank && llm && places.length > 1) {
        const left = FOOD_TIMEOUT_MS - (clock() - started) - DEADLINE_MARGIN_MS;
        if (left < MIN_RERANK_MS) {
          ctx.log.warn("food re-rank skipped", { leftMs: left });
          warnings.push(RERANK_FAILED_WARNING);
        } else {
          const rctx: RerankContext = {
            request: input.request,
            cuisine: input.cuisine,
            budget: input.budget,
            openNow: input.openNow,
          };
          try {
            const reply = await rerank(llm, rctx, places, search.addresses, {
              signal: ctx.signal,
              timeoutMs: Math.min(RERANK_TIMEOUT_MS, left),
            });
            const ranked = applyRanking(places, reply, rctx);
            places = ranked.places;
            ctx.log.info("food re-rank", { returned: reply.ranked.length, known: ranked.known });
            // An empty list is a valid "no preference"; only ids that all miss are a failure.
            if (reply.ranked.length > 0 && ranked.known === 0) {
              warnings.push(RERANK_FAILED_WARNING);
            }
          } catch (err) {
            // A caller abort propagates, as it does from Places.
            if (!(err instanceof LlmError) || err.kind === "aborted") throw err;
            ctx.log.warn("food re-rank failed", { kind: err.kind });
            warnings.push(RERANK_FAILED_WARNING);
          }
        }
      }

      return {
        status: warnings.length > 0 ? "partial" : "ok",
        data: { places: places.slice(0, MAX_PLACES) },
        sources: [{ ...PLACES_SOURCE }],
        warnings,
      };
    },
  };
}
