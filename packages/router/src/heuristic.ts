import type { Budget, SkillName, TravelMode } from "@aroundus/core";
import type { UserIntent } from "./intent.ts";

// Keyword intent parser: the fallback when Gemini is off, unconfigured or
// failing. It favours precision: calling a skill for small talk ("safe
// travels!") is worse than missing an oddly phrased question, which Gemini
// handles when it's up. So skills are only picked for messages that ask for
// something (see `isAsking`), and ambiguous words never pick one on their own.

/** Longer messages are cut before parsing; no real ask needs more. */
export const MAX_HEURISTIC_CHARS = 500;

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

/**
 * Event categories. `picks` says whether the word alone signals an events ask
 * ("any comedy tonight?"); ambiguous ones ("park", "kids", "games") only tag.
 */
const CATEGORIES: Record<string, { pattern: RegExp; picks: boolean }> = {
  music: { pattern: /\b(music|concerts?|live band|jazz|gigs?)\b/, picks: true },
  comedy: { pattern: /\b(comedy|stand-?up|improv)\b/, picks: true },
  film: { pattern: /\b(movies?|films?|cinema|screenings?)\b/, picks: true },
  art: { pattern: /\b(art|galler(y|ies)|museums?|exhibits?|exhibitions?)\b/, picks: true },
  theater: { pattern: /\b(theat(er|re)|broadway|musicals?)\b/, picks: true },
  outdoors: { pattern: /\b(outdoors?|outside|parks?|hikes?|nature)\b/, picks: false },
  sports: { pattern: /\b(sports?|games?|basketball|baseball|soccer)\b/, picks: false },
  dance: { pattern: /\b(danc(e|ing)|clubbing)\b/, picks: false },
  family: { pattern: /\b(kids?|family|children)\b/, picks: false },
  fitness: { pattern: /\b(fitness|yoga|workouts?|run club)\b/, picks: false },
  market: { pattern: /\b(markets?|flea|street fair)\b/, picks: false },
};

const NEEDS: Record<SkillName, RegExp> = {
  safety: /\b(safe|safety|unsafe|sketchy|dangerous|danger|crime|shady)\b/,
  food: /\b(eat|food|dinner|lunch|breakfast|brunch|restaurants?|hungry|a bite|snack)\b/,
  events: new RegExp(
    [
      String.raw`\b(things|stuff|something|anything|somewhere|places?) (fun )?to do\b`,
      String.raw`\bwhat to do\b`,
      String.raw`\b(what'?s|anything) (on|happening|going on)\b`,
      String.raw`\bevents?\b`,
      String.raw`\bactivit(y|ies)\b`,
      String.raw`\bentertainment\b`,
      String.raw`\b(something|anything|stuff|things|places?|spots?|somewhere) fun\b`,
      String.raw`\bfun (things|stuff|places|spots|ideas)\b`,
      String.raw`\bfor fun\b`,
      String.raw`\b(any|good) shows?\b`,
    ].join("|"),
  ),
  route:
    /\b(directions?|how (do|can|should) (i|we) get|how (far|long) (is it |does it take )?to\b|get me to|take me to|route to)\b/,
};

// "plan a night out" and "what should we do tonight" mean the whole evening.
const PLAN =
  /\b(plan|planning)\b.*\b(night|evening|day|date|weekend|outing|afternoon)\b|\bnight out\b|\bdate night\b|\bwhat should (we|i) do\b/;

const WHEN =
  /\b(right now|now|tonight|today|this (morning|afternoon|evening|weekend)|tomorrow( (morning|afternoon|evening|night))?|(at|around|after|by|before) \d{1,2}(:\d{2})? ?(am|pm)?|\d{1,2}(:\d{2})? ?(am|pm)|late tonight|after dark)\b/;

const BUDGETS: [RegExp, Budget][] = [
  [/\bfree\b/, "free"],
  [/\b(cheap|budget|inexpensive|affordable)\b/, "low"],
  [/\b(mid[- ]?range|moderate)\b/, "medium"],
  [/\b(fancy|upscale|splurge|expensive|high[- ]end|fine dining)\b/, "high"],
];

const MODES: [RegExp, TravelMode][] = [
  [/\b(walk|walking|on foot)\b/, "WALK"],
  [/\b(subway|train|transit|bus|mta)\b/, "TRANSIT"],
  [/\b(drive|driving|car|uber|lyft|taxi|cab)\b/, "DRIVE"],
  [/\b(bike|biking|cycle|cycling|citi ?bike)\b/, "BICYCLE"],
];

const OPEN_NOW = /\b(open (now|late|right now|tonight)|still open|open at this hour)\b/;

/** Words that aren't places: "near me", "around here". */
export const NOT_PLACES =
  /^(me|here|us|there|nearby|my (location|place|area|spot)|the area|this area|this spot|where i am)$/i;

// A place runs from "near"/"around" until punctuation or a word that starts
// something else (a time, a need, a budget). Whitespace is collapsed before
// matching, which keeps these lazy patterns linear.
const STOP_WORDS =
  "tonight|tomorrow|today|now|for|with|that|which|and|or|at|after|before|this|is|are|to|in|from|by|" +
  "safe|sketchy|dangerous|open|cheap|free|fancy|late|please|pls|asap";
const STOP = String.raw`(?= (?:${STOP_WORDS})\b|[?.!,;]|$)`;
const PLACE_NEAR = new RegExp(String.raw`\b(?:near|around|close to) (.+?)${STOP}`, "gi");
// "in Harlem", "At Joe's Pizza": needs a capital, since "in the mood" isn't a place.
const PLACE_IN = /\b(?:[Ii]n|[Aa]t) ((?:the )?[A-Z][\w'&.-]*(?: [A-Z][\w'&.-]*)*)/g;
const DESTINATION = new RegExp(
  String.raw`\b(?:get to|directions to|route to|take me to|walk to|walking to|head(?:ing)? to|far (?:is it )?to|long (?:is it )?to(?: get| walk)? to) (.+?)${STOP}`,
  "i",
);

// A message asks for something if it's a question, starts like a request, or
// names where. Statements ("got home safe", "that was fun") don't.
const REQUEST_START =
  /^(is|are|how|should|can|could|do|does|will|would|any|anything|anywhere|find|where|what|whats|which|recommend|suggest|looking|need|show|best|good|cheap|free|craving|somewhere|places?|spots?|things|plan|help|can you|could you|pls|please)\b/;
const REQUEST_ANYWHERE =
  /\b(i|we) (want|need|wanna|are looking|'?re looking)\b|\b(recommend|suggest|looking for)\b/;

function isAsking(lower: string, hasPlace: boolean): boolean {
  return (
    lower.includes("?") || REQUEST_START.test(lower) || REQUEST_ANYWHERE.test(lower) || hasPlace
  );
}

export function heuristicIntent(input: string): UserIntent {
  // Collapse whitespace and cap length first: normal text is unchanged, and
  // no input can make the lazy place patterns backtrack.
  const text = input.replace(/\s+/g, " ").replace(/’/g, "'").trim().slice(0, MAX_HEURISTIC_CHARS);

  const destination = DESTINATION.exec(text)?.[1]?.trim();
  const hasDestination = destination !== undefined && isPlace(destination);
  const place = findPlace(text, destination);

  // Keywords inside a place name ("get to Jin Ramen", "near Battery Park")
  // aren't requests.
  let rest = text;
  if (hasDestination) rest = rest.replace(destination, " ");
  if (place) rest = rest.replace(place, " ");
  const lower = rest.toLowerCase();

  const needs = new Set<SkillName>();
  const cuisine = CUISINES.filter((c) => new RegExp(`\\b${c}\\b`).test(lower));
  const categories = Object.entries(CATEGORIES)
    .filter(([, c]) => c.pattern.test(lower))
    .map(([name]) => name);

  if (hasDestination || NEEDS.route.test(lower)) needs.add("route");
  if (PLAN.test(lower)) for (const n of ["events", "food", "safety"] as const) needs.add(n);
  if (isAsking(lower, place !== undefined)) {
    if (NEEDS.safety.test(lower)) needs.add("safety");
    if (NEEDS.food.test(lower) || cuisine.length > 0) needs.add("food");
    if (NEEDS.events.test(lower)) needs.add("events");
    // A category alone ("any comedy tonight?") means events, but only when
    // nothing else was asked, so "is the Theater District safe" stays safety.
    const picks = categories.some((name) => CATEGORIES[name]?.picks);
    if (picks && needs.size === 0) needs.add("events");
  }

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
  if (OPEN_NOW.test(lower)) intent.openNow = true;
  return intent;
}

/** The first plausible place: "near X" first, then "in/at X". */
function findPlace(text: string, destination: string | undefined): string | undefined {
  for (const pattern of [PLACE_NEAR, PLACE_IN]) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1]?.trim();
      if (candidate && candidate !== destination && isPlace(candidate)) return candidate;
    }
  }
  return undefined;
}

function isPlace(candidate: string): boolean {
  // "around 8pm" is a time, "near me" is the pin.
  return !NOT_PLACES.test(candidate) && !/^\d/.test(candidate) && candidate.length >= 2;
}
