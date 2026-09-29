import type { Budget, SkillName, TravelMode } from "@aroundus/core";
import type { UserIntent } from "./intent.ts";

// Keyword intent parser: the fallback when Gemini is off, unconfigured or
// failing. Less clever than Gemini but good for focused questions.

const CUISINES = [
  "ramen",
  "pizza",
  "sushi",
  "tacos",
  "taco",
  "burger",
  "burgers",
  "bbq",
  "barbecue",
  "dumplings",
  "bagels",
  "bagel",
  "noodles",
  "pho",
  "curry",
  "halal",
  "vegan",
  "vegetarian",
  "seafood",
  "steak",
  "brunch",
  "coffee",
  "dessert",
  "ice cream",
  "mexican",
  "italian",
  "chinese",
  "thai",
  "indian",
  "korean",
  "japanese",
  "french",
  "greek",
  "ethiopian",
  "vietnamese",
  "caribbean",
  "mediterranean",
] as const;

const CATEGORIES: Record<string, RegExp> = {
  music: /\b(music|concerts?|live band|jazz|gig)\b/,
  comedy: /\b(comedy|stand-?up|improv)\b/,
  film: /\b(movies?|films?|cinema|screening)\b/,
  art: /\b(art|galler(y|ies)|museums?|exhibits?)\b/,
  outdoors: /\b(outdoors?|outside|parks?|hike|nature)\b/,
  sports: /\b(sports?|games?|basketball|baseball|soccer)\b/,
  theater: /\b(theat(er|re)|plays?|broadway|musicals?)\b/,
  dance: /\b(danc(e|ing)|club(bing)?)\b/,
  family: /\b(kids?|family|children)\b/,
  fitness: /\b(fitness|yoga|workout|run(ning)? club)\b/,
  market: /\b(markets?|flea|fair)\b/,
};

const NEEDS: Record<SkillName, RegExp> = {
  safety: /\b(safe|safety|unsafe|sketchy|dangerous|danger|crime|shady|sus)\b/,
  food: /\b(eat|eats|food|dinner|lunch|breakfast|brunch|restaurants?|hungry|a bite|grab a bite|snack)\b/,
  events:
    /\b(fun|things to do|to do|what'?s (on|happening|going on)|events?|shows?|activit(y|ies)|entertainment)\b/,
  route:
    /\b(directions?|how (do|can|should) (i|we) get|how (far|long)|get me to|take me to|route to)\b/,
};

const PLAN =
  /\b(plan|planning)\b.*\b(night|evening|day|date|weekend|outing|afternoon)\b|\bnight out\b|\bdate night\b/;

const WHEN =
  /\b(right now|now|tonight|this (morning|afternoon|evening|weekend)|tomorrow( (morning|afternoon|evening|night))?|(at|around|after|by) \d{1,2}(:\d{2})? ?(am|pm)?|\d{1,2}(:\d{2})? ?(am|pm))\b/;

const BUDGETS: [RegExp, Budget][] = [
  [/\bfree\b/, "free"],
  [/\b(cheap|budget|inexpensive|affordable|low[- ]key price)\b/, "low"],
  [/\b(mid[- ]?range|moderate)\b/, "medium"],
  [/\b(fancy|upscale|splurge|expensive|high[- ]end|fine dining)\b/, "high"],
];

const MODES: [RegExp, TravelMode][] = [
  [/\b(walk|walking|on foot)\b/, "WALK"],
  [/\b(subway|train|transit|bus|mta)\b/, "TRANSIT"],
  [/\b(drive|driving|car|uber|lyft|taxi|cab)\b/, "DRIVE"],
  [/\b(bike|biking|cycle|cycling|citi ?bike)\b/, "BICYCLE"],
];

// Places are copied as written. "near columbia" works in any case and runs to
// punctuation or a joining word; "in X" needs a capital ("in the mood" isn't a
// place). "me"/"here" aren't places.
const STOP = String.raw`(?=\s+(?:tonight|tomorrow|today|now|for|with|that|which|and|or|at|after|before|this|is|are|to)\b|[?.!,;]|$)`;
const PLACE_NEAR = new RegExp(String.raw`\b(?:near|around|close to)\s+(.+?)${STOP}`, "i");
const PLACE_IN = /\b(?:in|at)\s+((?:the\s+)?[A-Z][\w'’&.-]*(?:\s+[A-Z][\w'’&.-]*)*)/;
const DESTINATION =
  /\b(?:get to|go to|going to|directions to|route to|take me to|walk to|head(?:ing)? to|way to)\s+(.+?)(?=\s+(?:from|by|tonight|tomorrow|now|at \d)\b|[?.!,]|$)/i;
const NOT_PLACES = /^(me|here|us|my (location|place|area)|the area|this area|there)$/i;

export function heuristicIntent(text: string): UserIntent {
  const destination = DESTINATION.exec(text)?.[1]?.trim();
  const hasDestination = destination !== undefined && !NOT_PLACES.test(destination);
  const found = (PLACE_NEAR.exec(text) ?? PLACE_IN.exec(text))?.[1]?.trim();
  const place = found && !NOT_PLACES.test(found) && found !== destination ? found : undefined;

  // Keywords inside a place name ("get to Jin Ramen", "near Washington Square
  // Park") aren't requests.
  let rest = text;
  if (hasDestination) rest = rest.replace(destination, " ");
  if (place) rest = rest.replace(place, " ");
  const lower = rest.toLowerCase().replace(/’/g, "'");
  const needs = new Set<SkillName>();

  for (const [need, pattern] of Object.entries(NEEDS) as [SkillName, RegExp][]) {
    if (pattern.test(lower)) needs.add(need);
  }
  const cuisine = CUISINES.filter((c) => new RegExp(`\\b${c}\\b`).test(lower));
  if (cuisine.length > 0) needs.add("food");
  const categories = Object.entries(CATEGORIES)
    .filter(([, pattern]) => pattern.test(lower))
    .map(([name]) => name);
  if (categories.length > 0 && !needs.has("food")) needs.add("events");
  if (PLAN.test(lower)) for (const n of ["events", "food", "safety"] as const) needs.add(n);

  if (hasDestination) needs.add("route");

  const intent: UserIntent = {
    needs: [...needs],
    when: WHEN.exec(lower)?.[0] ?? "now",
    categories,
    cuisine: [...new Set(cuisine)],
  };

  if (place) intent.locationQuery = place;
  if (hasDestination) intent.destinationQuery = destination;
  const budget = BUDGETS.find(([p]) => p.test(lower))?.[1];
  if (budget) intent.budget = budget;
  const mode = MODES.find(([p]) => p.test(lower))?.[1];
  if (mode) intent.travelMode = mode;
  return intent;
}
