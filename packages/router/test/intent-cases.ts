import type { ChatLine, SkillName } from "@aroundus/core";
import type { UserIntent } from "../src/intent.ts";

/**
 * The routing table (README phase 3). `needs` must match on both the Gemini
 * and keyword paths; `fields` are checked on the keyword path, and on the
 * Gemini path too when `bothPaths` is set.
 */
export type IntentCase = {
  text: string;
  recent?: ChatLine[];
  needs: SkillName[];
  fields?: Partial<UserIntent>;
  bothPaths?: boolean;
};

export const INTENT_CASES: IntentCase[] = [
  { text: "Is it safe around me?", needs: ["safety"] },
  { text: "Where should we get dinner?", needs: ["food"] },
  {
    text: "What fun stuff is nearby tonight?",
    needs: ["events"],
    fields: { when: "tonight" },
    bothPaths: true,
  },
  {
    text: "How do I get to Jin Ramen?",
    needs: ["route"],
    fields: { destinationQuery: "Jin Ramen" },
    bothPaths: true,
  },
  {
    text: "Plan a fun and safe night near Columbia",
    needs: ["safety", "food", "events"],
    fields: { locationQuery: "Columbia" },
    bothPaths: true,
  },
  { text: "hi", needs: [] },
  { text: "thanks!", needs: [] },
  { text: "what's the weather like", needs: [] },
  { text: "who are you?", needs: [] },
  {
    text: "is it sketchy near washington square park at night?",
    needs: ["safety"],
    fields: { locationQuery: "washington square park" },
  },
  {
    text: "cheap ramen near Columbia",
    needs: ["food"],
    fields: { cuisine: ["ramen"], budget: "low", locationQuery: "Columbia" },
    bothPaths: true,
  },
  {
    text: "any comedy shows tonight in the West Village?",
    needs: ["events"],
    fields: { categories: ["comedy"], locationQuery: "the West Village" },
  },
  {
    text: "directions to Central Park by subway",
    needs: ["route"],
    fields: { destinationQuery: "Central Park", travelMode: "TRANSIT" },
    bothPaths: true,
  },
  { text: "where can I grab a bite, and is it safe there?", needs: ["safety", "food"] },
  {
    text: "free concerts this weekend",
    needs: ["events"],
    fields: { budget: "free", when: "this weekend" },
  },
  {
    text: "how long to walk to the Met from here",
    needs: ["route"],
    fields: { destinationQuery: "the Met", travelMode: "WALK" },
  },
  {
    text: "what's happening in Brooklyn tomorrow evening",
    needs: ["events"],
    fields: { locationQuery: "Brooklyn", when: "tomorrow evening" },
  },
  { text: "good pizza?", needs: ["food"], fields: { cuisine: ["pizza"] }, bothPaths: true },
  {
    text: "what about sushi instead?",
    recent: [
      { role: "user", text: "where should we get dinner near Columbia" },
      { role: "agent", text: "Try Jin Ramen, 6 min walk." },
    ],
    needs: ["food"],
    fields: { cuisine: ["sushi"] },
    bothPaths: true,
  },
  { text: "plan a date night in the East Village", needs: ["safety", "food", "events"] },
  {
    text: "is it safe to walk to Jin Ramen from here at 11pm?",
    needs: ["safety", "route"],
    fields: { destinationQuery: "Jin Ramen" },
    bothPaths: true,
  },
];
