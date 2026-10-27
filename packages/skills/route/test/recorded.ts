import type { RouteData, RouteInput } from "@aroundus/core";

/** One live computeRoutes exchange, written by scripts/record-routes.ts. */
export type RecordedCase = {
  name: string;
  input: RouteInput;
  /** The raw computeRoutes JSON body. */
  response: unknown;
  /** What the skill returned live. */
  expected: RouteData;
};

export type RecordedFile = { recordedAt: string; cases: RecordedCase[] };
