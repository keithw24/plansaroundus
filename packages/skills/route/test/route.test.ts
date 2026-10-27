import {
  HttpUrl,
  RouteData,
  type RouteInput,
  type SkillContext,
  silentLogger,
} from "@aroundus/core";
import { describe, expect, it, vi } from "vitest";
import {
  createRouteSkill,
  directionsUrl,
  durationMinutes,
  ROUTE_TIMEOUT_MS,
  ROUTES_CALL_TIMEOUT_MS,
} from "../src/index.ts";
import * as R from "./responses.ts";

const NOW = new Date("2026-09-29T21:00:00-04:00");
const COLUMBIA = { label: "Columbia", latitude: 40.8075, longitude: -73.9626 };
const JIN = { label: "Jin Ramen", latitude: 40.8146, longitude: -73.9586 };

const input = (over: Partial<RouteInput> = {}): RouteInput => ({
  origin: COLUMBIA,
  destination: JIN,
  travelMode: "WALK",
  departureTime: "2026-09-29T21:10:00-04:00",
  ...over,
});

const ctx = (over: Partial<SkillContext> = {}): SkillContext => ({
  now: NOW,
  signal: new AbortController().signal,
  log: silentLogger,
  ...over,
});

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

/** A fake fetch that answers every call with `status` and `body`, honouring the signal. */
function fakeFetch(body: unknown, status = 200) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "Content-Type": "application/json" } });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

/** A fetch that never answers; rejects only if its signal aborts (when `honour`). */
function hangingFetch(honour = true) {
  return vi.fn(
    (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        if (honour) init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  ) as unknown as typeof fetch;
}

const KEY = "test-maps-key";

describe("route skill with a key", () => {
  it("walk: duration, distance, link, and a minimal request", async () => {
    const f = fakeFetch(R.WALK);
    const skill = createRouteSkill({ mapsKey: KEY, fetch: f.fetch });
    const res = await skill.run(input(), ctx());

    expect(res.status).toBe("ok");
    if (res.status === "unavailable") throw new Error("unreachable");
    expect(res.data).toEqual({
      travelMode: "WALK",
      durationMinutes: 15, // 874s = 14.6 min
      distanceMeters: 1180,
      directionsUrl: directionsUrl(input()),
    });
    expect(RouteData.safeParse(res.data).success).toBe(true);
    expect(res.warnings).toEqual([]);
    expect(res.sources[0]?.name).toMatch(/Routes/);

    const [call] = f.calls;
    expect(call?.url).toBe("https://routes.googleapis.com/directions/v2:computeRoutes");
    expect(call?.init.method).toBe("POST");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe(KEY);
    expect(headers["X-Goog-FieldMask"]).toBe("routes.duration,routes.distanceMeters");
    expect(call?.body.travelMode).toBe("WALK");
    expect(call?.body).not.toHaveProperty("routingPreference");
    expect(call?.body).not.toHaveProperty("departureTime");
  });

  it("transit: one ride gives '1 train to 116 St', with a departure time and transit field mask", async () => {
    const f = fakeFetch(R.TRANSIT_ONE_RIDE);
    const skill = createRouteSkill({ mapsKey: KEY, fetch: f.fetch });
    const res = await skill.run(input({ travelMode: "TRANSIT" }), ctx());

    expect(res.status).toBe("ok");
    expect(res.data).toMatchObject({
      travelMode: "TRANSIT",
      durationMinutes: 22,
      distanceMeters: 4210,
      summary: "1 train to 116 St",
    });
    const call = f.calls[0];
    if (!call) throw new Error("no call");
    expect(call.body.departureTime).toBe("2026-09-30T01:10:00.000Z");
    expect(call.body).not.toHaveProperty("routingPreference");
    const mask = (call.init.headers as Record<string, string>)["X-Goog-FieldMask"];
    expect(mask).toContain("routes.legs.steps.transitDetails.transitLine.nameShort");
    expect(mask).toContain("routes.legs.steps.transitDetails.stopDetails.arrivalStop.name");
    expect(mask).not.toMatch(/polyline|\*/);
  });

  it("transit: a transfer and long chains stay short", async () => {
    const skill = (body: unknown) =>
      createRouteSkill({ mapsKey: KEY, fetch: fakeFetch(body).fetch });
    const transit = input({ travelMode: "TRANSIT" });

    const transfer = await skill(R.TRANSIT_TRANSFER).run(transit, ctx());
    expect(transfer.data?.summary).toBe("A train → 2 train to Wall St");

    const many = await skill(R.TRANSIT_MANY).run(transit, ctx());
    expect(many.data?.summary).toBe("M4 bus → 2 more → Third Avenue Local bus to Hub");

    const walkOnly = await skill(R.TRANSIT_WALK_ONLY).run(transit, ctx());
    expect(walkOnly.status).toBe("ok");
    expect(walkOnly.data?.durationMinutes).toBe(8);
    expect(walkOnly.data).not.toHaveProperty("summary");
  });

  it("transit: a departure time in the past is sent as now", async () => {
    const f = fakeFetch(R.TRANSIT_ONE_RIDE);
    const skill = createRouteSkill({ mapsKey: KEY, fetch: f.fetch });
    await skill.run(
      input({ travelMode: "TRANSIT", departureTime: "2026-09-29T20:00:00-04:00" }),
      ctx(),
    );
    expect(f.calls[0]?.body.departureTime).toBe(NOW.toISOString());
  });

  it("drive: traffic-aware, a future departure is sent, a 'now' one is left out", async () => {
    const f = fakeFetch(R.DRIVE);
    const skill = createRouteSkill({ mapsKey: KEY, fetch: f.fetch });
    const res = await skill.run(input({ travelMode: "DRIVE" }), ctx());
    expect(res.status).toBe("ok");
    expect(res.data).toMatchObject({ durationMinutes: 17, distanceMeters: 5320 });
    expect(res.data).not.toHaveProperty("summary");
    expect(f.calls[0]?.body).toMatchObject({
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
      departureTime: "2026-09-30T01:10:00.000Z",
    });

    await skill.run(
      input({ travelMode: "DRIVE", departureTime: "2026-09-29T21:00:00-04:00" }),
      ctx(),
    );
    expect(f.calls[1]?.body).not.toHaveProperty("departureTime");
  });

  it("bicycle", async () => {
    const f = fakeFetch(R.BICYCLE);
    const skill = createRouteSkill({ mapsKey: KEY, fetch: f.fetch });
    const res = await skill.run(input({ travelMode: "BICYCLE" }), ctx());
    expect(res.data).toMatchObject({ travelMode: "BICYCLE", durationMinutes: 11 });
    expect(res.data?.directionsUrl).toContain("travelmode=bicycling");
    expect(f.calls[0]?.body.travelMode).toBe("BICYCLE");
    expect(f.calls[0]?.body).not.toHaveProperty("routingPreference");
    expect(f.calls[0]?.body).not.toHaveProperty("departureTime");
  });

  it("waypoints: lat/lng without a place id, placeId with one", async () => {
    const f = fakeFetch(R.WALK);
    const skill = createRouteSkill({ mapsKey: KEY, fetch: f.fetch });

    await skill.run(input(), ctx());
    expect(f.calls[0]?.body.origin).toEqual({
      location: { latLng: { latitude: 40.8075, longitude: -73.9626 } },
    });
    expect(f.calls[0]?.body.destination).toEqual({
      location: { latLng: { latitude: 40.8146, longitude: -73.9586 } },
    });

    await skill.run(input({ destination: { ...JIN, placeId: "ChIJ-jin" } }), ctx());
    expect(f.calls[1]?.body.origin).toEqual({
      location: { latLng: { latitude: 40.8075, longitude: -73.9626 } },
    });
    expect(f.calls[1]?.body.destination).toEqual({ placeId: "ChIJ-jin" });
  });
});

describe("fallback: a link, never a time", () => {
  const expectFallback = (res: Awaited<ReturnType<ReturnType<typeof createRouteSkill>["run"]>>) => {
    expect(res.status).toBe("partial");
    if (res.status === "unavailable") throw new Error("unreachable");
    expect(res.data).not.toHaveProperty("durationMinutes");
    expect(res.data).not.toHaveProperty("distanceMeters");
    expect(res.data).not.toHaveProperty("summary");
    expect(HttpUrl.safeParse(res.data.directionsUrl).success).toBe(true);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/^No travel time/);
    return res;
  };

  it("no key: no network call", async () => {
    const f = fakeFetch(R.WALK);
    const skill = createRouteSkill({ mapsKey: null, fetch: f.fetch });
    const res = expectFallback(await skill.run(input({ travelMode: "TRANSIT" }), ctx()));
    expect(res.data.travelMode).toBe("TRANSIT");
    expect(res.data.directionsUrl).toContain("travelmode=transit");
    expect(res.warnings[0]).toMatch(/not configured/);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["HTTP 403", R.ERROR_403, 403],
    ["HTTP 429", R.ERROR_429, 429],
    ["HTTP 500 with an HTML body", "<html>oops</html>", 500],
    ["empty routes", R.EMPTY, 200],
    ["an empty routes array", { routes: [] }, 200],
    ["bad JSON", "{not json", 200],
    ["a schema mismatch", { routes: [{ duration: 874 }] }, 200],
    ["a route without a duration", { routes: [{ distanceMeters: 10 }] }, 200],
  ])("%s", async (_name, body, status) => {
    const skill = createRouteSkill({ mapsKey: KEY, fetch: fakeFetch(body, status).fetch });
    expectFallback(await skill.run(input(), ctx()));
  });

  it("a network error", async () => {
    const failing = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const skill = createRouteSkill({ mapsKey: KEY, fetch: failing });
    const res = expectFallback(await skill.run(input(), ctx()));
    expect(res.warnings[0]).toMatch(/couldn't reach/);
  });

  it("logs no locations, names or key", async () => {
    const lines: string[] = [];
    const log = {
      ...silentLogger,
      info: (m: string, f?: object) => lines.push(JSON.stringify([m, f])),
      warn: (m: string, f?: object) => lines.push(JSON.stringify([m, f])),
      child: () => log,
    };
    const dest = { ...JIN, label: "Jin's Secret Spot", placeId: "ChIJ-jin" };
    for (const body of [R.WALK, R.ERROR_403]) {
      const skill = createRouteSkill({ mapsKey: KEY, fetch: fakeFetch(body, 200).fetch });
      await skill.run(input({ destination: dest }), ctx({ log }));
    }
    await createRouteSkill({ mapsKey: null }).run(input({ destination: dest }), ctx({ log }));
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join("\n");
    for (const secret of ["40.8", "73.9", "Jin", "ChIJ", "Columbia", KEY]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe("timeouts and aborts", () => {
  it("the Routes call is bounded well inside the skill timeout", () => {
    expect(ROUTES_CALL_TIMEOUT_MS).toBeLessThan(ROUTE_TIMEOUT_MS - 1000);
    expect(createRouteSkill({ mapsKey: null }).timeoutMs).toBe(ROUTE_TIMEOUT_MS);
  });

  it("an internal timeout gives the fallback, and aborts the fetch", async () => {
    vi.useFakeTimers();
    try {
      const fetch = hangingFetch();
      const skill = createRouteSkill({ mapsKey: KEY, fetch });
      const pending = skill.run(input(), ctx());
      await vi.advanceTimersByTimeAsync(ROUTES_CALL_TIMEOUT_MS);
      const res = await pending;
      expect(res.status).toBe("partial");
      expect(res.warnings[0]).toMatch(/timed out/);
      const init = vi.mocked(fetch).mock.calls[0]?.[1];
      expect(init?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out even when fetch ignores its signal", async () => {
    const skill = createRouteSkill({
      mapsKey: KEY,
      fetch: hangingFetch(false),
      routesTimeoutMs: 20,
    });
    const res = await skill.run(input(), ctx());
    expect(res.status).toBe("partial");
    expect(res.data).not.toHaveProperty("durationMinutes");
  });

  it("ctx.signal aborting mid-call rejects with its reason and aborts the fetch", async () => {
    const fetch = hangingFetch();
    const controller = new AbortController();
    const skill = createRouteSkill({ mapsKey: KEY, fetch });
    const pending = skill.run(input(), ctx({ signal: controller.signal }));
    const reason = new Error("dispatcher timeout");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("an already-aborted signal makes no call", async () => {
    const f = fakeFetch(R.WALK);
    const skill = createRouteSkill({ mapsKey: KEY, fetch: f.fetch });
    await expect(skill.run(input(), ctx({ signal: AbortSignal.abort() }))).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

describe("directionsUrl", () => {
  it("lat/lng destination, every travel mode", () => {
    const modes = { WALK: "walking", TRANSIT: "transit", DRIVE: "driving", BICYCLE: "bicycling" };
    for (const [travelMode, maps] of Object.entries(modes)) {
      const url = new URL(
        directionsUrl(input({ travelMode: travelMode as RouteInput["travelMode"] })),
      );
      expect(url.origin + url.pathname).toBe("https://www.google.com/maps/dir/");
      expect(url.searchParams.get("api")).toBe("1");
      expect(url.searchParams.get("origin")).toBe("40.8075,-73.9626");
      expect(url.searchParams.get("destination")).toBe("40.8146,-73.9586");
      expect(url.searchParams.has("destination_place_id")).toBe(false);
      expect(url.searchParams.get("travelmode")).toBe(maps);
    }
  });

  it("encodes names with spaces, apostrophes and ampersands", () => {
    const label = "Joe's Pizza & Pasta #2";
    const raw = directionsUrl(input({ destination: { ...JIN, label, placeId: "ChIJ abc/+=" } }));
    expect(HttpUrl.safeParse(raw).success).toBe(true);
    expect(raw).toContain("destination=Joe%27s+Pizza+%26+Pasta+%232");
    expect(raw).not.toMatch(/[ '#]/);
    const url = new URL(raw);
    expect(url.searchParams.get("destination")).toBe(label);
    expect(url.searchParams.get("destination_place_id")).toBe("ChIJ abc/+=");
  });
});

describe("durationMinutes", () => {
  it.each([
    ["0s", 0],
    ["1s", 1],
    ["29s", 1],
    ["90s", 2],
    ["874s", 15],
    ["1326.5s", 22],
    ["3600s", 60],
  ])("%s → %i", (d, m) => expect(durationMinutes(d)).toBe(m));
});

describe("input", () => {
  const skill = createRouteSkill({ mapsKey: null });

  it.each([
    ["an unknown travel mode", { travelMode: "FLY" }],
    ["a departure time with no offset", { departureTime: "2026-09-29T21:00:00" }],
    ["a latitude out of range", { origin: { ...COLUMBIA, latitude: 91 } }],
    ["an empty destination label", { destination: { ...JIN, label: " " } }],
    ["a missing destination", { destination: undefined }],
  ])("rejects %s", async (_name, over) => {
    const bad = { ...input(), ...over };
    expect(skill.input.safeParse(bad).success).toBe(false);
    await expect(skill.run(bad as RouteInput, ctx())).rejects.toThrow();
  });

  it("accepts a destination with a place id", () => {
    expect(skill.input.safeParse(input({ destination: { ...JIN, placeId: "x" } })).success).toBe(
      true,
    );
  });
});
