import type { Llm, TurnRunner } from "@aroundus/core";
import { parseIntent, type UserIntent } from "@aroundus/router";

export const WHERE_ARE_YOU =
  "Where are you? Share your location (or say a place, like “near Columbia”) and I’ll take it from there.";

export const HELP =
  "I can help with what’s around you in NYC: “is it safe around me?”, “where should we get dinner?”, “what’s on tonight?”, or “how do I get to Jin Ramen?”";

export const APOLOGY = "Sorry, something went wrong on my end. Try again in a moment?";

export const WHERE_TO = "Where do you want to go?";

export const SIGN_IN_UNAVAILABLE = "Sign-in isn’t available right now. Try again later.";

/**
 * Stands in for the router until phase 4: no location → ask for one, else the
 * help reply. Calls no skills.
 */
export const cannedTurn: TurnRunner = async ({ lastLocation }) =>
  lastLocation ? HELP : WHERE_ARE_YOU;

/**
 * Phase 3 stand-in for the router: parses the intent and follows the graph's
 * first decisions (no needs → help, no origin → ask, route with no
 * destination → ask), then says what it understood. Phase 4 replaces the last
 * step with real answers.
 */
export function createIntentPreviewTurn(llm: Llm | null): TurnRunner {
  return async ({ text, lastLocation, recent, flags, log, signal }) => {
    const { intent, source, fallback, locationFromRecent } = await parseIntent({
      text,
      recent,
      flags,
      llm,
      log,
      signal,
    });
    // Never the place names or other user words: logs aren't chat memory.
    log.info("intent", {
      source,
      fallback,
      needs: intent.needs,
      hasLocation: Boolean(intent.locationQuery),
      locationFromRecent,
      hasDestination: Boolean(intent.destinationQuery),
    });

    if (intent.needs.length === 0) return HELP;
    if (!intent.locationQuery && !lastLocation) return WHERE_ARE_YOU;
    // A route needs a destination, or a food/events pick to route to.
    const hasPickToRoute = intent.needs.includes("food") || intent.needs.includes("events");
    if (intent.needs.includes("route") && !intent.destinationQuery && !hasPickToRoute)
      return WHERE_TO;
    return describeIntent(intent, lastLocation ? lastLocation.label : null);
  };
}

/** "Got it: food (ramen, low budget) near Columbia, now. Real answers come next." */
export function describeIntent(intent: UserIntent, pinLabel: string | null): string {
  const details = [
    ...intent.cuisine,
    ...intent.categories,
    ...(intent.budget ? [`${intent.budget} budget`] : []),
    ...(intent.travelMode ? [intent.travelMode.toLowerCase()] : []),
  ];
  const what = `${intent.needs.join(" + ")}${details.length ? ` (${details.join(", ")})` : ""}`;
  const where = intent.locationQuery
    ? `near ${intent.locationQuery}`
    : `near your ${pinLabel ?? "pin"}`;
  const to = intent.destinationQuery ? `, to ${intent.destinationQuery}` : "";
  return `Got it: ${what} ${where}${to}, ${intent.when}. Real answers come in the next build.`;
}
