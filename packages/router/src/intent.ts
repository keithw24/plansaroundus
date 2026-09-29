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
import { heuristicIntent } from "./heuristic.ts";

// The .describe() text is the per-field prompt: the schema and the
// instructions can't drift apart.
export const UserIntent = z.object({
  needs: z
    .array(SkillName)
    .describe(
      "Skills the message asks for. safety: is an area safe, crime. food: restaurants, somewhere to eat. " +
        "events: fun things to do, shows, concerts, activities. route: how to get somewhere, travel time. " +
        "Empty for greetings, thanks, small talk or questions none of these answer.",
    ),
  locationQuery: z
    .string()
    .optional()
    .describe(
      "A place the user says they are at or asks about, copied exactly as written, e.g. 'Columbia' or " +
        "'the West Village'. Omit for 'me', 'here' or 'around me', and when no place is named.",
    ),
  destinationQuery: z
    .string()
    .optional()
    .describe(
      "For route requests: where they want to go, copied exactly as written, e.g. 'Jin Ramen'. " +
        "Omit when no destination is named.",
    ),
  when: z
    .string()
    .describe(
      "When, copied from the message: 'now', 'tonight', 'at 9pm', 'tomorrow evening'. 'now' if unstated.",
    ),
  budget: Budget.optional().describe(
    "Only if the user states a budget: free, low (cheap), medium, high (fancy). Omit otherwise.",
  ),
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
- Pick only the skills the message actually asks for.
- A broad ask like "plan a night out", "plan a fun and safe evening" or "what should we do tonight" means events, food and safety.
- Greetings, thanks and small talk mean no skills.
- Copy place names exactly as written. Never guess, correct or add a place.
- Recent lines are earlier messages in the same chat. Use them only to understand a follow-up like "what about ramen instead?"; answer the latest message.`;

export const INTENT_TIMEOUT_MS = 8_000;

export type IntentResult = {
  intent: UserIntent;
  source: "gemini" | "heuristic";
  /** Why Gemini wasn't used, when it wasn't. */
  fallback?: "flag_off" | "no_llm" | "empty" | LlmError["kind"] | "error";
};

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
  const heuristic = (fallback: NonNullable<IntentResult["fallback"]>): IntentResult => ({
    intent: sanitizeIntent(heuristicIntent(text), text, recent),
    source: "heuristic",
    fallback,
  });

  if (!text.trim()) return heuristic("empty");
  if (!input.flags.enabled("intent.gemini")) return heuristic("flag_off");
  if (!input.llm) return heuristic("no_llm");

  try {
    const raw = await input.llm.json({
      system: INTENT_SYSTEM,
      prompt: intentPrompt(text, recent),
      schema: UserIntent,
      timeoutMs: input.timeoutMs ?? INTENT_TIMEOUT_MS,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return { intent: sanitizeIntent(raw, text, recent), source: "gemini" };
  } catch (err) {
    const kind = err instanceof LlmError ? err.kind : "error";
    log.warn("intent: gemini failed, using keywords", { kind, err });
    return heuristic(kind);
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
 * - a place is kept only if it actually appears in the message or the user's
 *   recent lines, so a model can't invent one;
 * - lists trimmed, lower-cased and deduplicated; `when` defaults to "now".
 */
export function sanitizeIntent(intent: UserIntent, text: string, recent: ChatLine[]): UserIntent {
  const said = normalize(
    [text, ...recent.filter((l) => l.role === "user").map((l) => l.text)].join("\n"),
  );
  const place = (q: string | undefined) => {
    const trimmed = q?.trim();
    return trimmed && said.includes(normalize(trimmed)) ? trimmed : undefined;
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
  const locationQuery = place(intent.locationQuery);
  if (locationQuery) out.locationQuery = locationQuery;
  const destinationQuery = place(intent.destinationQuery);
  if (destinationQuery) out.destinationQuery = destinationQuery;
  if (intent.budget) out.budget = intent.budget;
  if (intent.travelMode) out.travelMode = intent.travelMode;
  return out;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ");
}
