import {
  Budget,
  type ChatLine,
  type Llm,
  LlmError,
  type Logger,
  type SenderFlags,
  SKILL_NAMES,
  SkillName,
  TravelMode,
} from "@aroundus/core";
import { z } from "zod";
import { heuristicIntent, NOT_PLACES } from "./heuristic.ts";

// The .describe() text is the per-field prompt: the schema and the
// instructions can't drift apart.
export const UserIntent = z.object({
  needs: z
    .array(SkillName)
    .describe(
      "Skills the latest message asks for. safety: is an area safe, crime. food: restaurants, somewhere to eat. " +
        "events: fun things to do, shows, concerts, activities. route: how to get somewhere, travel time. " +
        "Empty for greetings, thanks, small talk (e.g. 'safe travels!', 'that was fun') or questions none of these answer.",
    ),
  locationQuery: z
    .string()
    .optional()
    .describe(
      "The origin: where the user is, or the area they want things near or ask about ('near Columbia', " +
        "'is the West Village safe'). Copied exactly as written. Not a place they want to travel to; that is " +
        "destinationQuery. Omit for 'me', 'here', 'around me' or 'nearby', and when no place is named.",
    ),
  destinationQuery: z
    .string()
    .optional()
    .describe(
      "Only for route requests: the place they want to get to, copied exactly as written, e.g. 'Jin Ramen'. " +
        "Omit when no destination is named.",
    ),
  when: z
    .string()
    .describe(
      "The time words as written in the message: 'now', 'tonight', 'at 9pm', 'tomorrow evening', 'after dark'. " +
        "'now' if no time is given.",
    ),
  budget: Budget.optional().describe(
    "Only if the user states a price level, for food or events: free, low (cheap), medium, high (fancy). Omit otherwise.",
  ),
  openNow: z
    .boolean()
    .optional()
    .describe("true only if they ask for places open now or open late. Omit otherwise."),
  categories: z
    .array(z.string())
    .describe(
      "Event types mentioned, lower case, e.g. 'music', 'comedy', 'outdoors'. Empty if none.",
    ),
  cuisine: z
    .array(z.string())
    .describe(
      "Foods or cuisines mentioned, lower case, e.g. 'ramen', 'pizza', 'thai'. Empty if none.",
    ),
  travelMode: TravelMode.optional().describe(
    "Only if the user says how they'll travel: WALK, TRANSIT (subway, train, bus), DRIVE (car, taxi), " +
      "BICYCLE. Omit otherwise.",
  ),
});
export type UserIntent = z.infer<typeof UserIntent>;

export const INTENT_SYSTEM = `You turn one message to a New York City guide into a structured request.
Rules:
- Pick only the skills the latest message actually asks for.
- A broad ask like "plan a night out", "plan a fun and safe evening" or "what should we do tonight" means events, food and safety.
- Greetings, thanks and small talk mean no skills, even if they contain words like "safe" or "fun".
- Words inside a place name are not requests: "take me to Joe's Pizza" is only a route, "is Battery Park safe" is only safety.
- Copy place names exactly as written. Never guess, correct, expand or add a place. "Me", "here" and "nearby" are not places.
- Recent lines are earlier messages in the same chat. Use them only when the latest message is a follow-up like "what about ramen instead?": then keep the user's earlier place. Never take a place from the agent's lines.`;

export const INTENT_TIMEOUT_MS = 8_000;

export type IntentResult = {
  intent: UserIntent;
  source: "gemini" | "heuristic";
  /** Why Gemini wasn't used, when it wasn't. */
  fallback?: "flag_off" | "no_llm" | "empty" | LlmError["kind"] | "error";
  /**
   * The origin came from the user's earlier lines, not this message. A pin
   * shared in this turn should win over it.
   */
  locationFromRecent: boolean;
};

const EMPTY_INTENT: UserIntent = { needs: [], when: "now", categories: [], cuisine: [] };

/**
 * Turns a message into a UserIntent. Uses Gemini when allowed and configured,
 * and the keyword parser otherwise or whenever Gemini fails. Never throws.
 */
export async function parseIntent(input: {
  text: string;
  recent: ChatLine[];
  flags: SenderFlags;
  llm: Llm | null;
  log: Logger;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<IntentResult> {
  const { text, recent, log } = input;
  const finish = (
    raw: UserIntent,
    source: IntentResult["source"],
    fallback?: NonNullable<IntentResult["fallback"]>,
  ): IntentResult => {
    const { intent, locationFromRecent } = sanitizeIntent(raw, text, recent);
    return { intent, source, locationFromRecent, ...(fallback ? { fallback } : {}) };
  };
  const heuristic = (fallback: NonNullable<IntentResult["fallback"]>): IntentResult => {
    try {
      return finish(heuristicIntent(text), "heuristic", fallback);
    } catch (err) {
      log.error("intent: keyword parser failed", { err });
      return finish(EMPTY_INTENT, "heuristic", fallback);
    }
  };

  let geminiAllowed: boolean;
  try {
    geminiAllowed = input.flags.enabled("intent.gemini");
  } catch (err) {
    log.error("intent: flag check failed", { err });
    geminiAllowed = false;
  }
  if (!text.trim()) return heuristic("empty");
  if (!geminiAllowed) return heuristic("flag_off");
  if (!input.llm) return heuristic("no_llm");

  let raw: UserIntent;
  try {
    raw = await input.llm.json({
      system: INTENT_SYSTEM,
      prompt: intentPrompt(text, recent),
      schema: UserIntent,
      timeoutMs: input.timeoutMs ?? INTENT_TIMEOUT_MS,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (err) {
    const kind = err instanceof LlmError ? err.kind : "error";
    // Only the kind: error messages can quote the model's reply, which can quote the user.
    if (kind === "aborted") log.debug("intent: turn aborted during gemini call");
    else log.warn("intent: gemini failed, using keywords", { kind });
    return heuristic(kind);
  }
  try {
    return finish(raw, "gemini");
  } catch (err) {
    log.error("intent: could not check gemini output", { err });
    return heuristic("error");
  }
}

/** The prompt: recent lines for context, then the message itself. */
export function intentPrompt(text: string, recent: ChatLine[]): string {
  const history = recent.map((l) => `${l.role}: ${l.text}`).join("\n");
  return history ? `Recent lines:\n${history}\n\nMessage: ${text}` : `Message: ${text}`;
}

/**
 * Code-side checks on any intent, from Gemini or keywords:
 * - needs deduplicated, in a fixed order;
 * - a place is kept only if the user actually wrote it, as whole words, in
 *   this message or their own recent lines, so a model can't invent one;
 *   "me"/"here" are never places;
 * - lists trimmed, lower-cased and deduplicated; `when` defaults to "now".
 */
export function sanitizeIntent(
  intent: UserIntent,
  text: string,
  recent: ChatLine[],
): { intent: UserIntent; locationFromRecent: boolean } {
  const inMessage = ` ${normalize(text)} `;
  const inUserLines = ` ${normalize(
    recent
      .filter((l) => l.role === "user")
      .map((l) => l.text)
      .join(" "),
  )} `;
  const place = (q: string | undefined): { value: string; fromRecent: boolean } | undefined => {
    const value = q?.trim();
    if (!value || NOT_PLACES.test(value)) return undefined;
    const needle = normalize(value);
    if (needle.length < 2) return undefined;
    if (inMessage.includes(` ${needle} `)) return { value, fromRecent: false };
    if (inUserLines.includes(` ${needle} `)) return { value, fromRecent: true };
    return undefined;
  };
  const list = (items: string[]) => [
    ...new Set(items.map((i) => i.trim().toLowerCase()).filter(Boolean)),
  ];

  const out: UserIntent = {
    needs: SKILL_NAMES.filter((n) => intent.needs.includes(n)),
    when: intent.when.trim() || "now",
    categories: list(intent.categories),
    cuisine: list(intent.cuisine),
  };
  const location = place(intent.locationQuery);
  if (location) out.locationQuery = location.value;
  // From the user's own earlier line counts ("…get to Jin Ramen" then "by subway?").
  const destination = place(intent.destinationQuery);
  if (destination) out.destinationQuery = destination.value;
  if (intent.budget) out.budget = intent.budget;
  if (intent.openNow) out.openNow = true;
  if (intent.travelMode) out.travelMode = intent.travelMode;
  return { intent: out, locationFromRecent: location?.fromRecent ?? false };
}

/**
 * For comparing places: lower case, no accents, apostrophes dropped
 * ("Hell's" = "Hells"), other punctuation as spaces ("St. Marks" = "St Marks").
 */
function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
