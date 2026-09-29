import type { TurnRunner } from "@aroundus/core";

export const WHERE_ARE_YOU =
  "Where are you? Share your location (or say a place, like “near Columbia”) and I’ll take it from there.";

export const HELP =
  "I can help with what’s around you in NYC: “is it safe around me?”, “where should we get dinner?”, “what’s on tonight?”, or “how do I get to Jin Ramen?”";

export const APOLOGY = "Sorry, something went wrong on my end. Try again in a moment?";

export const SIGN_IN_UNAVAILABLE = "Sign-in isn’t available right now. Try again later.";

/**
 * Stands in for the router until phase 4: no location → ask for one, else the
 * help reply. Calls no skills.
 */
export const cannedTurn: TurnRunner = async ({ lastLocation }) =>
  lastLocation ? HELP : WHERE_ARE_YOU;
