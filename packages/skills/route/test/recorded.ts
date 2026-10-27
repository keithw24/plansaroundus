import type { RouteData, RouteInput } from "@aroundus/core";

/** One live computeRoutes exchange, written by scripts/record-routes.ts. */
export type RecordedCase = {
  name: string;
  /** ctx.now for the live run, so a replay builds the same request. */
  now: string;
  input: RouteInput;
  /** What the skill sent: the X-Goog-FieldMask header and the JSON body. */
  request: { fieldMask: string; body: Record<string, unknown> };
  httpStatus: number;
  /** Google's raw response body. */
  responseText: string;
  /** What the skill returned live. */
  expected: { status: "ok" | "partial"; data: RouteData; warnings: string[] };
};

export type RecordedFile = { recordedAt: string; cases: RecordedCase[] };
