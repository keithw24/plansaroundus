// The route skill: see README section 8. Travel time from Google Routes, plus a
// Maps directions link built in code. Without a key, or when Routes fails, it
// still returns the link, with no duration and no distance (`partial`): the
// reply never claims a time it doesn't have.
import {
  type RouteData,
  RouteInput,
  type SkillContext,
  type SkillRegistry,
  type SkillResult,
} from "@aroundus/core";
import { directionsUrl } from "./maps-url.ts";
import {
  durationMinutes,
  fieldMask,
  ROUTES_ENDPOINT,
  RoutesResponse,
  routesRequest,
  transitSummary,
} from "./routes-api.ts";

export { directionsUrl, MAPS_URL_MAX } from "./maps-url.ts";
export { durationMinutes, fieldMask, routesRequest, transitSummary } from "./routes-api.ts";

/** The dispatcher's budget for the whole skill. */
export const ROUTE_TIMEOUT_MS = 5_000;
/** The Routes call alone, well inside ROUTE_TIMEOUT_MS so the fallback link still makes it. */
export const ROUTES_CALL_TIMEOUT_MS = 3_500;

export type RouteSkillOptions = {
  mapsKey: string | null;
  fetch?: typeof fetch;
  /** Overrides ROUTES_CALL_TIMEOUT_MS (tests). */
  routesTimeoutMs?: number;
};

/** Why there's no travel time. Codes for logs; `warning` is the human version. */
type FallbackReason = "not_configured" | "http" | "bad_response" | "no_route" | "timeout" | "error";

/** On an `ok` transit result whose requested departure was too far back for Routes. */
export const LEAVING_NOW_WARNING =
  "Travel time is for leaving now: the requested departure is more than 7 days ago.";

const WARNINGS: Record<FallbackReason, string> = {
  not_configured: "No travel time: Google Routes is not configured.",
  http: "No travel time: Google Routes returned an error.",
  bad_response: "No travel time: Google Routes returned an unreadable response.",
  no_route: "No travel time: Google Routes found no route.",
  timeout: "No travel time: Google Routes timed out.",
  error: "No travel time: couldn't reach Google Routes.",
};

class Fallback extends Error {
  readonly reason: FallbackReason;
  readonly detail: Record<string, unknown>;
  constructor(reason: FallbackReason, detail: Record<string, unknown> = {}) {
    super(reason);
    this.reason = reason;
    this.detail = detail;
  }
}

export function createRouteSkill(opts: RouteSkillOptions): SkillRegistry["route"] {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const routesTimeoutMs = opts.routesTimeoutMs ?? ROUTES_CALL_TIMEOUT_MS;

  return {
    name: "route",
    input: RouteInput,
    timeoutMs: ROUTE_TIMEOUT_MS,
    async run(rawInput, ctx) {
      // The dispatcher validated already; this guards direct callers. Bad input throws.
      const input = RouteInput.parse(rawInput);
      ctx.signal.throwIfAborted();
      const url = directionsUrl(input);
      const log = ctx.log.child({ skill: "route", travelMode: input.travelMode });
      const started = Date.now();

      if (!opts.mapsKey) {
        log.info("route fallback", { reason: "not_configured" });
        return fallback(input.travelMode, url, "not_configured");
      }

      const request = routesRequest(input, ctx.now);
      try {
        const route = await callRoutes(
          opts.mapsKey,
          input,
          request.body,
          ctx,
          doFetch,
          routesTimeoutMs,
        );
        const data: RouteData = {
          travelMode: input.travelMode,
          durationMinutes: durationMinutes(route.duration),
          ...(route.distanceMeters === undefined ? {} : { distanceMeters: route.distanceMeters }),
          ...(route.summary === undefined ? {} : { summary: route.summary }),
          directionsUrl: url,
        };
        log.info("route ok", { ms: Date.now() - started, durationMinutes: data.durationMinutes });
        return {
          status: "ok",
          data,
          sources: [{ name: "Google Maps Routes" }],
          // The time is real but for leaving now, which the reply has to say.
          warnings: request.departureMovedToNow ? [LEAVING_NOW_WARNING] : [],
        };
      } catch (err) {
        // The caller gave up (dispatcher timeout or shutdown): stop, don't answer.
        if (ctx.signal.aborted) throw ctx.signal.reason ?? err;
        if (err instanceof Fallback) {
          log.warn("route fallback", {
            reason: err.reason,
            ms: Date.now() - started,
            ...err.detail,
          });
          return fallback(input.travelMode, url, err.reason);
        }
        log.warn("route fallback", {
          reason: "error",
          ms: Date.now() - started,
          error: err instanceof Error ? err.name : "unknown",
        });
        return fallback(input.travelMode, url, "error");
      }
    },
  };
}

function fallback(
  travelMode: RouteData["travelMode"],
  url: string,
  reason: FallbackReason,
): SkillResult<RouteData> {
  return {
    status: "partial",
    data: { travelMode, directionsUrl: url },
    sources: [],
    warnings: [WARNINGS[reason]],
  };
}

/**
 * One computeRoutes call, bounded by `timeoutMs` and `ctx.signal`. Resolves
 * with the first route's facts or throws a Fallback. The race also covers a
 * fetch that ignores its signal, so the skill can never hang past the bound.
 */
async function callRoutes(
  key: string,
  input: RouteInput,
  body: Record<string, unknown>,
  ctx: SkillContext,
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<{ duration: string; distanceMeters?: number; summary?: string }> {
  const controller = new AbortController();
  const stop = (reason: unknown) => controller.abort(reason);
  const onAbort = () => stop(ctx.signal.reason);
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop(new Fallback("timeout")), timeoutMs);

  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
      once: true,
    });
  });
  aborted.catch(() => {}); // only observed through the race

  const work = async () => {
    const res = await doFetch(ROUTES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": fieldMask(input.travelMode),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Fallback("http", { httpStatus: res.status, ...googleError(text) });

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Fallback("bad_response", { httpStatus: res.status, problem: "json" });
    }
    const parsed = RoutesResponse.safeParse(json);
    if (!parsed.success) throw new Fallback("bad_response", { problem: "schema" });
    const route = parsed.data.routes?.[0];
    if (!route) throw new Fallback("no_route");
    if (route.duration === undefined) throw new Fallback("bad_response", { problem: "duration" });

    const summary = input.travelMode === "TRANSIT" ? transitSummary(route) : undefined;
    return {
      duration: route.duration,
      ...(route.distanceMeters === undefined ? {} : { distanceMeters: route.distanceMeters }),
      ...(summary === undefined ? {} : { summary }),
    };
  };

  try {
    return await Promise.race([work(), aborted]);
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

/** Google's error status code ("PERMISSION_DENIED"), for logs. Never the message, which can echo input. */
function googleError(text: string): { googleStatus?: string } {
  try {
    const status = (JSON.parse(text) as { error?: { status?: unknown } }).error?.status;
    return typeof status === "string" ? { googleStatus: status } : {};
  } catch {
    return {};
  }
}
