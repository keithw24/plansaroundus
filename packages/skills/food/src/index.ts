// The food skill (README section 8): Places Text Search, then an optional
// Gemini re-rank by candidate id. Returns the top 5 as FoodData.
import { FoodInput, type Llm, LlmError, type SkillRegistry } from "@aroundus/core";
import { PLACES_SOURCE, PLACES_TIMEOUT_MS, searchPlaces } from "./places.ts";
import { applyRanking, RERANK_TIMEOUT_MS, rerank } from "./rerank.ts";

export {
  budgetFit,
  budgetFromPriceLevel,
  PLACES_FIELD_MASK,
  PLACES_SEARCH_URL,
  PlacesError,
  searchBody,
  textQuery,
} from "./places.ts";
export { applyRanking, RERANK_SYSTEM, RerankReply, rerankPrompt } from "./rerank.ts";

export const MAX_PLACES = 5;
/** Places plus the re-rank, with a little headroom. */
export const FOOD_TIMEOUT_MS = PLACES_TIMEOUT_MS + RERANK_TIMEOUT_MS + 1000;

export const RERANK_FAILED_WARNING = "Couldn't re-rank restaurants; showing Google's order.";

export type FoodSkillOptions = {
  /** Required: without a Maps key the router leaves this skill out of the registry. */
  mapsKey: string;
  /** Optional: without one, results keep Places' order. */
  llm?: Llm | null;
  fetch?: typeof fetch;
};

export function createFoodSkill(opts: FoodSkillOptions): SkillRegistry["food"] {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const llm = opts.llm ?? null;
  return {
    name: "food",
    input: FoodInput,
    timeoutMs: FOOD_TIMEOUT_MS,
    async run(input, ctx) {
      const started = Date.now();
      const search = await searchPlaces({
        mapsKey: opts.mapsKey,
        fetch: doFetch,
        origin: input.origin,
        cuisine: input.cuisine,
        budget: input.budget,
        openNow: input.openNow,
        signal: ctx.signal,
      });
      // Counts only: the user's request text is never logged.
      ctx.log.info("places search", {
        candidates: search.candidates.length,
        malformed: search.malformed,
        filtered: search.filtered,
        ms: Date.now() - started,
      });

      let places = search.candidates;
      const warnings: string[] = [];
      if (input.rerank && llm && places.length > 1) {
        try {
          const reply = await rerank(llm, input.request, places, search.addresses, ctx.signal);
          const ranked = applyRanking(places, reply);
          places = ranked.places;
          ctx.log.info("food re-rank", {
            returned: reply.ranked.length,
            known: ranked.known,
          });
          if (ranked.known === 0) warnings.push(RERANK_FAILED_WARNING);
        } catch (err) {
          if (!(err instanceof LlmError)) throw err;
          ctx.log.warn("food re-rank failed", { kind: err.kind });
          warnings.push(RERANK_FAILED_WARNING);
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
