import type { ChatLine, SkillName } from "@aroundus/core";
import type { UserIntent } from "../src/intent.ts";

/**
 * The routing table (README phase 3). `needs` and `fields` must match on both
 * the Gemini and keyword paths; `heuristic` and `gemini` add checks for one
 * path only (the keyword parser ignores recent lines, for example).
 */
export type IntentCase = {
  text: string;
  recent?: ChatLine[];
  needs: SkillName[];
  fields?: Partial<UserIntent>;
  heuristic?: Partial<UserIntent>;
  gemini?: Partial<UserIntent>;
  /** Expected IntentResult.locationFromRecent on the Gemini path. */
  locationFromRecent?: boolean;
};

const dinnerNearColumbia: ChatLine[] = [
  { role: "user", text: "where should we get dinner near Columbia" },
  { role: "agent", text: "Try Jin Ramen, 6 min walk." },
];

export const INTENT_CASES: IntentCase[] = [
  // The README's five examples.
  { text: "Is it safe around me?", needs: ["safety"] },
  { text: "Where should we get dinner?", needs: ["food"] },
  { text: "What fun stuff is nearby tonight?", needs: ["events"], fields: { when: "tonight" } },
  {
    text: "How do I get to Jin Ramen?",
    needs: ["route"],
    fields: { destinationQuery: "Jin Ramen" },
  },
  {
    text: "Plan a fun and safe night near Columbia",
    needs: ["safety", "food", "events"],
    fields: { locationQuery: "Columbia" },
  },

  // Small talk, including words that look like asks.
  { text: "hi", needs: [] },
  { text: "thanks!", needs: [] },
  { text: "what's the weather like", needs: [] },
  { text: "who are you?", needs: [] },
  { text: "safe travels!", needs: [] },
  { text: "lol that's fun", needs: [] },
  { text: "have fun at the game!", needs: [] },
  { text: "going to be late sorry", needs: [] },
  { text: "how long have you lived here", needs: [] },

  // Focused asks.
  {
    text: "is it sketchy near washington square park at night?",
    needs: ["safety"],
    fields: { locationQuery: "washington square park" },
  },
  { text: "near Times Square safe?", needs: ["safety"], fields: { locationQuery: "Times Square" } },
  { text: "is Prospect Park safe after dark", needs: ["safety"] },
  {
    text: "cheap ramen near Columbia",
    needs: ["food"],
    fields: { cuisine: ["ramen"], budget: "low", locationQuery: "Columbia" },
  },
  {
    text: "dumplings in Chinatown",
    needs: ["food"],
    fields: { cuisine: ["dumplings"], locationQuery: "Chinatown" },
  },
  {
    text: "restaurants near me in Harlem",
    needs: ["food"],
    fields: { locationQuery: "Harlem" },
  },
  { text: "any restaurants open now around here?", needs: ["food"], fields: { openNow: true } },
  { text: "good pizza?", needs: ["food"], fields: { cuisine: ["pizza"] } },
  {
    text: "any comedy shows tonight in the West Village?",
    needs: ["events"],
    fields: { categories: ["comedy"] },
    // Either is the user's own words; both geocode the same.
    heuristic: { locationQuery: "the West Village" },
    gemini: { locationQuery: "West Village" },
  },
  { text: "free concerts this weekend", needs: ["events"], fields: { budget: "free" } },
  { text: "things to do around 8pm", needs: ["events"], heuristic: { when: "around 8pm" } },
  {
    text: "what's happening in Brooklyn tomorrow evening",
    needs: ["events"],
    fields: { locationQuery: "Brooklyn", when: "tomorrow evening" },
  },

  // Routes.
  {
    text: "directions to Central Park by subway",
    needs: ["route"],
    fields: { destinationQuery: "Central Park", travelMode: "TRANSIT" },
  },
  {
    text: "how long to walk to the Met from here",
    needs: ["route"],
    fields: { destinationQuery: "the Met", travelMode: "WALK" },
  },
  {
    text: "how far is it to Times Square",
    needs: ["route"],
    fields: { destinationQuery: "Times Square" },
  },
  { text: "take me to Joe's Pizza", needs: ["route"], fields: { destinationQuery: "Joe's Pizza" } },

  // Mixed and broad.
  { text: "where can I grab a bite, and is it safe there?", needs: ["safety", "food"] },
  { text: "plan a date night in the East Village", needs: ["safety", "food", "events"] },
  { text: "what should we do tonight", needs: ["safety", "food", "events"] },
  {
    text: "is it safe to walk to Jin Ramen from here at 11pm?",
    needs: ["safety", "route"],
    fields: { destinationQuery: "Jin Ramen" },
  },

  // Follow-ups: the keyword parser only sees the latest message.
  {
    text: "what about sushi instead?",
    recent: dinnerNearColumbia,
    needs: ["food"],
    fields: { cuisine: ["sushi"] },
    gemini: { locationQuery: "Columbia" },
    locationFromRecent: true,
  },
];
