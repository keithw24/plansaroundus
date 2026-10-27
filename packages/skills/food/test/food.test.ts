import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createLlm,
  FoodData,
  FoodInput,
  type FoodInput as FoodInputT,
  type Generate,
  type Llm,
  LlmError,
  type Logger,
  silentLogger,
} from "@aroundus/core";
import { describe, expect, it, vi } from "vitest";
import {
  budgetFit,
  budgetFromPriceLevel,
  createFoodSkill,
  DEADLINE_MARGIN_MS,
  FOOD_TIMEOUT_MS,
  PLACES_FIELD_MASK,
  PLACES_SEARCH_URL,
  PlacesError,
  RERANK_FAILED_WARNING,
  RERANK_TIMEOUT_MS as RERANK_TIMEOUT,
  reasonFor,
  textQuery,
  WHY_CODES,
} from "../src/index.ts";
import { searchPlaces } from "../src/places.ts";
import {
  COLUMBIA,
  fakeFetch,
  fixtureKey,
  googleError,
  NEIGHBORHOOD,
  type PlacesLiveFixture,
  place,
  placesResponse,
  RERANK_CASES,
  type RerankFixture,
} from "./places-fixtures.ts";

const ctx = (log: Logger = silentLogger) => ({
  now: new Date("2026-10-26T19:00:00-04:00"),
  signal: new AbortController().signal,
  log,
});

const input = (over: Partial<FoodInputT> = {}): FoodInputT =>
  FoodInput.parse({ origin: COLUMBIA, request: "dinner?", rerank: false, ...over });

/** An Llm that fails the test if it is ever called. */
const noLlm: Llm = {
  json: vi.fn(async () => {
    throw new Error("the model should not be called");
  }),
};

const llmReplying = (reply: unknown) => {
  const generate = vi.fn<Generate>(async () => JSON.stringify(reply));
  return { llm: createLlm(generate), generate };
};

function expectValid(data: unknown) {
  expect(FoodData.safeParse(data).success).toBe(true);
}

describe("food skill: Places search", () => {
  it("sends a field-masked Text Search biased to the origin", async () => {
    const f = fakeFetch(() => placesResponse([place(1)]));
    const skill = createFoodSkill({ mapsKey: "test-key", fetch: f.fetch });
    await skill.run(input({ cuisine: ["ramen"] }), ctx());

    expect(f.calls).toHaveLength(1);
    const call = f.calls[0];
    expect(call?.url).toBe(PLACES_SEARCH_URL);
    expect(call?.init.method).toBe("POST");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("test-key");
    expect(headers["X-Goog-FieldMask"]).toBe(PLACES_FIELD_MASK);
    expect(PLACES_FIELD_MASK).not.toContain("*");
    expect(call?.body).toMatchObject({
      textQuery: "ramen restaurant",
      pageSize: 10,
      locationBias: {
        circle: { center: { latitude: COLUMBIA.latitude, longitude: COLUMBIA.longitude } },
      },
    });
    expect(call?.body).not.toHaveProperty("openNow");
    // The user's words never go to Places.
    expect(JSON.stringify(call?.body)).not.toContain("dinner?");
  });

  it("returns valid recommendations with place ids, coordinates and links", async () => {
    const f = fakeFetch(() => placesResponse(NEIGHBORHOOD));
    const skill = createFoodSkill({ mapsKey: "k", fetch: f.fetch });
    const result = await skill.run(input(), ctx());

    expect(result.status).toBe("ok");
    if (result.status === "unavailable") return;
    expectValid(result.data);
    expect(result.data.places).toHaveLength(5);
    expect(result.sources).toEqual([{ name: "Google Places" }]);
    expect(result.warnings).toEqual([]);
    const [first] = result.data.places;
    expect(first).toEqual({
      kind: "food",
      id: "places:ChIJfake1",
      placeId: "ChIJfake1",
      name: "Morningside Ramen House",
      location: {
        label: "Morningside Ramen House",
        latitude: 40.8066,
        longitude: -73.9626,
      },
      distanceMeters: 100,
      priceLevel: "low",
      rating: 4.4,
      openNow: true,
      categories: ["ramen_restaurant", "japanese_restaurant", "restaurant"],
      url: "https://maps.google.com/?cid=1001",
      source: { name: "Google Places", url: "https://maps.google.com/?cid=1001" },
    });
    // Places' order is kept when there's no budget and no re-rank.
    expect(result.data.places.map((p) => p.placeId)).toEqual([
      "ChIJfake1",
      "ChIJfake2",
      "ChIJfake3",
      "ChIJfake4",
      "ChIJfake5",
    ]);
  });

  it("an empty result is ok with no places", async () => {
    for (const body of [undefined, []]) {
      const skill = createFoodSkill({
        mapsKey: "k",
        fetch: fakeFetch(() => placesResponse(body)).fetch,
      });
      const result = await skill.run(input(), ctx());
      expect(result).toMatchObject({ status: "ok", data: { places: [] } });
    }
  });

  it.each([
    [403, "PERMISSION_DENIED", "Requests to this API are blocked."],
    [429, "RESOURCE_EXHAUSTED", "Quota exceeded."],
    [400, "INVALID_ARGUMENT", 'Invalid textQuery "my secret ramen" restaurant'],
    [500, "INTERNAL", "Internal error."],
  ])("throws a clear error on HTTP %i", async (code, status, message) => {
    const skill = createFoodSkill({
      mapsKey: "secret-key",
      fetch: fakeFetch(() => googleError(code, status, message)).fetch,
    });
    const err = await skill
      .run(input({ cuisine: ["my secret ramen"] }), ctx())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlacesError);
    // Status only: Google's message can echo the user's words.
    expect((err as Error).message).toBe(`Places searchText failed: HTTP ${code} ${status}`);
    expect((err as Error).message).not.toContain("secret");
  });

  it("an error body without a status word still gives the HTTP code", async () => {
    const skill = createFoodSkill({
      mapsKey: "k",
      fetch: fakeFetch(() => new Response("Too many requests for ramen", { status: 429 })).fetch,
    });
    await expect(skill.run(input(), ctx())).rejects.toThrow(/^Places searchText failed: HTTP 429$/);
  });

  it("a timeout while reading the body becomes a PlacesError", async () => {
    const stalled = (async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      return {
        ok: true,
        status: 200,
        text: () =>
          new Promise<string>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason)),
          ),
      } as unknown as Response;
    }) as typeof fetch;
    const err = await searchPlaces({
      mapsKey: "k",
      fetch: stalled,
      origin: COLUMBIA,
      cuisine: [],
      budget: undefined,
      openNow: false,
      signal: new AbortController().signal,
      timeoutMs: 20,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlacesError);
    expect((err as Error).message).toBe("Places searchText timed out after 20 ms");
  });

  it("throws on a body that isn't JSON or isn't the documented shape", async () => {
    for (const body of ["<html>oops</html>", '{"places": "nope"}', "[]"]) {
      const skill = createFoodSkill({
        mapsKey: "k",
        fetch: fakeFetch(() => new Response(body, { status: 200 })).fetch,
      });
      await expect(skill.run(input(), ctx())).rejects.toThrow(/Places searchText returned/);
    }
  });

  it("throws when fetch itself fails, and passes the caller's abort through", async () => {
    const down = createFoodSkill({
      mapsKey: "k",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(down.run(input(), ctx())).rejects.toThrow(/request failed: fetch failed/);

    const aborted = new AbortController();
    aborted.abort(new Error("dispatcher timeout"));
    const skill = createFoodSkill({
      mapsKey: "k",
      fetch: fakeFetch(() => placesResponse([place(1)])).fetch,
    });
    await expect(skill.run(input(), { ...ctx(), signal: aborted.signal })).rejects.toThrow();
  });

  it("drops malformed candidates and keeps the rest", async () => {
    const f = fakeFetch(() =>
      placesResponse([
        place(1),
        { ...place(2), id: "" }, // no id
        { ...place(3), displayName: undefined }, // no name
        { ...place(4), location: { latitude: 140, longitude: 0 } }, // bad coordinates
        "not an object",
        null,
        // Bad optional fields are dropped, not the place.
        place(5, { rating: 9, googleMapsUri: "javascript:alert(1)", priceLevel: 3, types: "x" }),
        place(1), // duplicate
      ]),
    );
    const log = { ...silentLogger, info: vi.fn(), child: () => log };
    const skill = createFoodSkill({ mapsKey: "k", fetch: f.fetch });
    const result = await skill.run(input(), ctx(log));

    expect(result.status).toBe("ok");
    if (result.status === "unavailable") return;
    expectValid(result.data);
    expect(result.data.places.map((p) => p.placeId)).toEqual(["ChIJfake1", "ChIJfake5"]);
    const loose = result.data.places[1];
    expect(loose).not.toHaveProperty("rating");
    expect(loose).not.toHaveProperty("url");
    expect(loose).not.toHaveProperty("priceLevel");
    expect(loose?.categories).toEqual([]);
    expect(loose?.source).toEqual({ name: "Google Places" });
    expect(log.info).toHaveBeenCalledWith(
      "places search",
      expect.objectContaining({ malformed: 5 }),
    );
  });

  it("drops places far from the origin", async () => {
    const far = place(9, { location: { latitude: 40.7, longitude: -74.0 } }); // ~12 km
    const skill = createFoodSkill({
      mapsKey: "k",
      fetch: fakeFetch(() => placesResponse([place(1), far])).fetch,
    });
    const result = await skill.run(input(), ctx());
    expect(result.data?.places.map((p) => p.placeId)).toEqual(["ChIJfake1"]);
  });

  it("only keeps http(s) Maps links", async () => {
    const skill = createFoodSkill({
      mapsKey: "k",
      fetch: fakeFetch(() =>
        placesResponse([place(1, { googleMapsUri: "ftp://maps.google.com/x" })]),
      ).fetch,
    });
    const result = await skill.run(input(), ctx());
    expect(result.data?.places[0]).not.toHaveProperty("url");
  });
});

describe("food skill: openNow and budget", () => {
  it("passes openNow through to Places and drops places reported closed", async () => {
    const f = fakeFetch(() =>
      placesResponse([place(1), place(2, { currentOpeningHours: { openNow: false } })]),
    );
    const skill = createFoodSkill({ mapsKey: "k", fetch: f.fetch });
    const result = await skill.run(input({ openNow: true }), ctx());
    expect(f.calls[0]?.body.openNow).toBe(true);
    expect(result.data?.places.map((p) => p.placeId)).toEqual(["ChIJfake1"]);
  });

  it("without openNow, closed places are kept and labelled", async () => {
    const skill = createFoodSkill({
      mapsKey: "k",
      fetch: fakeFetch(() =>
        placesResponse([place(1, { currentOpeningHours: { openNow: false } })]),
      ).fetch,
    });
    const result = await skill.run(input(), ctx());
    expect(result.data?.places[0]?.openNow).toBe(false);
  });

  it.each([
    ["PRICE_LEVEL_FREE", "free"],
    ["PRICE_LEVEL_INEXPENSIVE", "low"],
    ["PRICE_LEVEL_MODERATE", "medium"],
    ["PRICE_LEVEL_EXPENSIVE", "high"],
    ["PRICE_LEVEL_VERY_EXPENSIVE", "high"],
    ["PRICE_LEVEL_UNSPECIFIED", undefined],
    ["PRICE_LEVEL_SOMETHING_NEW", undefined],
    [undefined, undefined],
  ])("maps %s to %s", (level, budget) => {
    expect(budgetFromPriceLevel(level)).toBe(budget);
  });

  it("treats the budget as a ceiling, with free asks treated like low", () => {
    expect(budgetFit("high", undefined)).toBe("fits");
    expect(budgetFit(undefined, "low")).toBe("unknown");
    expect(budgetFit("low", "low")).toBe("fits");
    expect(budgetFit("medium", "low")).toBe("over");
    expect(budgetFit("medium", "medium")).toBe("fits");
    expect(budgetFit("high", "medium")).toBe("over");
    expect(budgetFit("low", "free")).toBe("fits");
    expect(budgetFit("medium", "free")).toBe("over");
    expect(budgetFit("high", "high")).toBe("fits");
  });

  it("drops over-budget places and ranks unpriced ones after those that fit", async () => {
    const skill = createFoodSkill({
      mapsKey: "k",
      fetch: fakeFetch(() => placesResponse(NEIGHBORHOOD)).fetch,
    });
    const result = await skill.run(input({ budget: "low" }), ctx());
    expect(result.data?.places.map((p) => p.name)).toEqual([
      "Morningside Ramen House",
      "Green Bowl Vegan Cafe",
      "Amsterdam Ave Pizza",
      "Night Owl Diner", // no price level: kept, but last
    ]);
  });

  it("sends no price filter to Places, so unpriced places can still be found", async () => {
    const f = fakeFetch(() => placesResponse([]));
    await createFoodSkill({ mapsKey: "k", fetch: f.fetch }).run(input({ budget: "high" }), ctx());
    expect(f.calls[0]?.body).not.toHaveProperty("priceLevels");
  });

  it("for a high budget, lists high-priced places first and keeps everything else", async () => {
    const skill = createFoodSkill({
      mapsKey: "k",
      fetch: fakeFetch(() => placesResponse(NEIGHBORHOOD)).fetch,
    });
    const result = await skill.run(input({ budget: "high" }), ctx());
    expect(result.data?.places.map((p) => [p.name, p.priceLevel])).toEqual([
      ["Broadway Steak Room", "high"],
      ["Candlelight Trattoria", "high"],
      ["Morningside Ramen House", "low"],
      ["Green Bowl Vegan Cafe", "low"],
      ["Amsterdam Ave Pizza", "low"],
    ]);
  });

  it("handles PRICE_LEVEL_UNSPECIFIED, missing opening hours and a nextPageToken", async () => {
    const skill = createFoodSkill({
      mapsKey: "k",
      fetch: fakeFetch(() => placesResponse(NEIGHBORHOOD.slice(6))).fetch,
    });
    const result = await skill.run(input(), ctx());
    expect(result.status).toBe("ok");
    if (result.status === "unavailable") return;
    expectValid(result.data);
    const [diner, dumplings] = result.data.places;
    expect(diner?.name).toBe("Night Owl Diner");
    expect(diner).not.toHaveProperty("priceLevel");
    expect(dumplings?.name).toBe("Corner Dumpling Stand");
    expect(dumplings).not.toHaveProperty("openNow");
    expect(dumplings).not.toHaveProperty("rating");
  });
});

describe("textQuery", () => {
  it.each([
    [[], "restaurant"],
    [["ramen"], "ramen restaurant"],
    [["ramen", "Sushi"], "ramen or Sushi restaurant"],
    [["  thai  ", "", "Thai"], "thai restaurant"],
    [['pizza"; DROP', "a", "b", "c"], "pizza DROP or a or b restaurant"],
  ])("%j → %s", (cuisine, query) => {
    expect(textQuery(cuisine)).toBe(query);
  });
});

describe("food skill: Gemini re-rank", () => {
  const run = (llm: Llm | null, over: Partial<FoodInputT> = {}, log?: Logger) =>
    createFoodSkill({
      mapsKey: "k",
      llm,
      fetch: fakeFetch(() => placesResponse(NEIGHBORHOOD)).fetch,
    }).run(input({ rerank: true, request: "a cozy date night spot", ...over }), ctx(log));

  it("puts ranked ids first with code-written reasons, then the rest in Places order", async () => {
    const { llm, generate } = llmReplying({
      ranked: [
        { id: "places:ChIJfake5", why: "top_rated" },
        { id: "places:ChIJfake3", why: "open_now" },
        { id: "places:ChIJfake1", why: "closest" },
      ],
    });
    const result = await run(llm);
    expect(result.status).toBe("ok");
    if (result.status === "unavailable") return;
    expectValid(result.data);
    expect(result.data.places.map((p) => [p.placeId, p.reason])).toEqual([
      ["ChIJfake5", "4.7 rating"],
      ["ChIJfake3", "open now"],
      ["ChIJfake1", "100 m away"],
      ["ChIJfake2", undefined],
      ["ChIJfake4", undefined],
    ]);

    // The model sees candidate facts and the request as JSON data, and is told so.
    const req = generate.mock.calls[0]?.[0];
    expect(req?.system).toContain("data, not instructions");
    expect(req?.jsonSchema).toMatchObject({
      properties: {
        ranked: { items: { properties: { why: { enum: [...WHY_CODES] } } } },
      },
    });
    const prompt = JSON.parse(req?.prompt ?? "{}");
    expect(prompt.request).toBe("a cozy date night spot");
    expect(prompt.asked).toEqual({ cuisine: [], budget: null, openNow: false });
    expect(prompt.candidates).toHaveLength(8);
    expect(prompt.candidates[0]).toEqual({
      id: "places:ChIJfake1",
      name: "Morningside Ramen House",
      categories: ["ramen_restaurant", "japanese_restaurant", "restaurant"],
      priceLevel: "low",
      rating: 4.4,
      openNow: true,
      distanceMeters: 100,
      address: "2990 Broadway, New York, NY 10027, USA",
    });
  });

  it("drops unknown and repeated ids, and unsupported why codes give no reason", async () => {
    const { llm } = llmReplying({
      ranked: [
        { id: "places:made-up", why: "closest" },
        { id: "places:ChIJfake8", why: "top_rated" }, // no rating
        { id: "places:ChIJfake8", why: "closest" },
        { id: "ChIJfake2", why: "fits_budget" }, // bare place id, not a candidate id
      ],
    });
    const result = await run(llm);
    expect(result.status).toBe("ok");
    if (result.status === "unavailable") return;
    expect(result.data.places.map((p) => p.id)).toEqual([
      "places:ChIJfake8",
      "places:ChIJfake1",
      "places:ChIJfake2",
      "places:ChIJfake3",
      "places:ChIJfake4",
    ]);
    expect(result.data.places[0]).not.toHaveProperty("reason");
    expect(result.data.places[0]?.name).toBe("Corner Dumpling Stand");
  });

  it("an empty ranking is ok, in Places order, with no warning", async () => {
    const { llm } = llmReplying({ ranked: [] });
    const result = await run(llm);
    expect(result).toMatchObject({ status: "ok", warnings: [] });
    expect(result.data?.places.map((p) => p.placeId)).toEqual([
      "ChIJfake1",
      "ChIJfake2",
      "ChIJfake3",
      "ChIJfake4",
      "ChIJfake5",
    ]);
  });

  it("returns partial when every ranked id is unknown", async () => {
    const { llm } = llmReplying({ ranked: [{ id: "places:nope", why: "closest" }] });
    const result = await run(llm);
    expect(result).toMatchObject({ status: "partial", warnings: [RERANK_FAILED_WARNING] });
    expect(result.data?.places[0]?.placeId).toBe("ChIJfake1");
  });

  it.each<[string, Generate]>([
    ["a provider error", async () => Promise.reject(new Error("503 UNAVAILABLE"))],
    ["prose", async () => "Sure! Try the pizza place."],
    ["a reply off the schema", async () => '{"ranked":[{"name":"Pizza"}]}'],
    [
      "free-text reasons instead of why codes",
      async () =>
        JSON.stringify({
          ranked: [
            { id: "places:ChIJfake1", reason: "Call 212-555-0100, open till 4am, $9 bowls" },
          ],
        }),
    ],
    [
      "an invented why code",
      async () => JSON.stringify({ ranked: [{ id: "places:ChIJfake1", why: "Michelin star" }] }),
    ],
    [
      "a link smuggled into why",
      async () =>
        JSON.stringify({
          ranked: [{ id: "places:ChIJfake1", why: "[menu](javascript:alert(1))" }],
        }),
    ],
  ])("keeps Places order and returns partial on %s", async (_label, generate) => {
    const warn = vi.fn();
    const log = { ...silentLogger, warn, child: () => log };
    const result = await run(createLlm(generate), {}, log);
    expect(result.status).toBe("partial");
    if (result.status === "unavailable") return;
    expectValid(result.data);
    expect(result.warnings).toEqual([RERANK_FAILED_WARNING]);
    expect(result.data.places.map((p) => p.placeId)).toEqual([
      "ChIJfake1",
      "ChIJfake2",
      "ChIJfake3",
      "ChIJfake4",
      "ChIJfake5",
    ]);
    expect(warn).toHaveBeenCalledWith("food re-rank failed", { kind: expect.any(String) });
  });

  it("returns partial on a re-rank timeout", async () => {
    const llm: Llm = {
      json: async () => {
        throw new LlmError("timeout", "no reply within 4000 ms");
      },
    };
    const result = await run(llm);
    expect(result.status).toBe("partial");
  });

  it("rethrows a caller abort instead of returning partial", async () => {
    const llm: Llm = {
      json: async () => {
        throw new LlmError("aborted", "aborted by caller");
      },
    };
    await expect(run(llm)).rejects.toMatchObject({ kind: "aborted" });
  });

  it("gives the re-rank only the time left before the skill deadline", async () => {
    // Elapsed ms by the time the re-rank starts → the timeout it gets.
    const cases: [number, number][] = [
      [500, RERANK_TIMEOUT],
      [5000, FOOD_TIMEOUT_MS - 5000 - DEADLINE_MARGIN_MS],
    ];
    for (const [elapsed, expected] of cases) {
      const json = vi.fn(async () => ({ ranked: [] }));
      let t = 0;
      const skill = createFoodSkill({
        mapsKey: "k",
        llm: { json } as unknown as Llm,
        fetch: fakeFetch(() => {
          t = elapsed;
          return placesResponse(NEIGHBORHOOD);
        }).fetch,
        clock: () => t,
      });
      const result = await skill.run(input({ rerank: true }), ctx());
      expect(result.status).toBe("ok");
      const call = (json.mock.calls[0] as unknown[] | undefined)?.[0] as { timeoutMs: number };
      expect(call.timeoutMs).toBe(expected);
    }
  });

  it("skips the re-rank (partial, Places order) when under a second is left", async () => {
    const json = vi.fn(async () => ({ ranked: [] }));
    let t = 0;
    const skill = createFoodSkill({
      mapsKey: "k",
      llm: { json } as unknown as Llm,
      fetch: fakeFetch(() => {
        t = FOOD_TIMEOUT_MS - DEADLINE_MARGIN_MS - 900;
        return placesResponse(NEIGHBORHOOD);
      }).fetch,
      clock: () => t,
    });
    const result = await skill.run(input({ rerank: true }), ctx());
    expect(result).toMatchObject({ status: "partial", warnings: [RERANK_FAILED_WARNING] });
    expect(result.data?.places[0]?.placeId).toBe("ChIJfake1");
    expect(json).not.toHaveBeenCalled();
  });

  it("rethrows errors that aren't from the model, so bugs surface", async () => {
    const llm: Llm = {
      json: async () => {
        throw new TypeError("bug");
      },
    };
    await expect(run(llm)).rejects.toThrow("bug");
  });

  it("skips Gemini when rerank is false, when there's no llm, or with one candidate", async () => {
    const off = await run(noLlm, { rerank: false });
    expect(off.status).toBe("ok");
    const none = await run(null);
    expect(none.status).toBe("ok");
    const single = await createFoodSkill({
      mapsKey: "k",
      llm: noLlm,
      fetch: fakeFetch(() => placesResponse([place(1)])).fetch,
    }).run(input({ rerank: true }), ctx());
    expect(single.status).toBe("ok");
    expect(noLlm.json).not.toHaveBeenCalled();
  });

  it("never logs the user's request", async () => {
    const lines: string[] = [];
    const record = (msg: string, fields?: unknown) => lines.push(msg + JSON.stringify(fields));
    const log: Logger = {
      debug: record,
      info: record,
      warn: record,
      error: record,
      child: () => log,
    };
    await run(
      createLlm(async () => "not json"),
      { request: "secret plans for tonight" },
      log,
    );
    const { llm } = llmReplying({ ranked: [{ id: "places:ChIJfake1", why: "closest" }] });
    await run(llm, { request: "secret plans for tonight" }, log);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("secret");
  });

  it("passes the caller's signal and a short timeout to llm.json", async () => {
    const json = vi.fn(async () => ({ ranked: [] }));
    await run({ json } as unknown as Llm);
    const call = (json.mock.calls[0] as unknown[] | undefined)?.[0] as
      | { timeoutMs: number; signal: AbortSignal }
      | undefined;
    expect(call?.signal).toBeInstanceOf(AbortSignal);
    expect(call?.timeoutMs).toBeLessThan(FOOD_TIMEOUT_MS);
  });
});

describe("reasonFor: why codes only hold when the facts support them", () => {
  const base = {
    kind: "food" as const,
    id: "places:x",
    placeId: "x",
    name: "X",
    location: { ...COLUMBIA, label: "X" },
    categories: ["ramen_restaurant", "restaurant"],
    source: { name: "Google Places" },
  };
  const near = {
    ...base,
    distanceMeters: 340,
    rating: 4.6,
    openNow: true,
    priceLevel: "low" as const,
  };
  const far = { ...base, id: "places:y", distanceMeters: 2400 };
  const asked = { request: "", cuisine: ["Ramen"], budget: "low" as const, openNow: false };
  const all = [near, far];

  it.each<[Parameters<typeof reasonFor>[0], object, object, string | undefined]>([
    ["closest", near, asked, "340 m away"],
    ["closest", far, asked, undefined], // not nearby and not the nearest
    ["top_rated", near, asked, "4.6 rating"],
    ["top_rated", { ...near, rating: 3.9 }, asked, undefined],
    ["top_rated", far, asked, undefined], // no rating
    ["matches_cuisine", near, asked, "ramen restaurant"],
    ["matches_cuisine", near, { ...asked, cuisine: [] }, undefined],
    ["matches_cuisine", near, { ...asked, cuisine: ["sushi"] }, undefined],
    ["fits_budget", near, asked, "inexpensive"],
    ["fits_budget", near, { ...asked, budget: undefined }, undefined],
    ["fits_budget", { ...near, priceLevel: "high" }, asked, undefined],
    ["fits_budget", far, asked, undefined], // no price
    ["open_now", near, asked, "open now"],
    ["open_now", { ...near, openNow: false }, asked, undefined],
    ["open_now", far, asked, undefined], // hours unknown
  ])("%s on %j", (why, place, ctxOver, text) => {
    const p = place as typeof near;
    expect(reasonFor(why, p, { ...asked, ...ctxOver }, all)).toBe(text);
  });

  it("closest holds for the nearest candidate even when it isn't close", () => {
    expect(reasonFor("closest", far, asked, [far])).toBe("2.4 km away");
  });
});

// Real Gemini replies over the hand-built candidates, recorded by
// scripts/record-rerank.ts and keyed by the full request.
const rerankFixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/rerank-gemini.json"), "utf8"),
) as RerankFixture;
const replay: Generate = async (req) => {
  const hit = rerankFixture.replies[fixtureKey(req)];
  if (!hit) throw new Error("no recorded reply for this request: run npm run record:rerank");
  return hit.reply;
};

describe(`food skill: recorded re-rank (${rerankFixture.model})`, () => {
  // [name, reason] for each place in the reply; reasons are written by code.
  const expected: Record<string, [string, string | undefined][]> = {
    "cheap ramen": [
      ["Morningside Ramen House", "100 m away"],
      ["Green Bowl Vegan Cafe", undefined],
      ["Amsterdam Ave Pizza", undefined],
      ["Night Owl Diner", undefined],
    ],
    "date night": [
      ["Candlelight Trattoria", "4.7 rating"],
      ["Broadway Steak Room", "high-end"],
      ["Morningside Ramen House", undefined],
      ["Green Bowl Vegan Cafe", undefined],
      ["Amsterdam Ave Pizza", undefined],
    ],
    vegan: [
      ["Green Bowl Vegan Cafe", "vegan restaurant"],
      ["Morningside Ramen House", undefined],
      ["Broadway Steak Room", undefined],
      ["Amsterdam Ave Pizza", undefined],
      ["Candlelight Trattoria", undefined],
    ],
  };
  it.each(RERANK_CASES)("$name", async (c) => {
    const skill = createFoodSkill({
      mapsKey: "k",
      llm: createLlm(replay),
      fetch: fakeFetch(() => placesResponse(NEIGHBORHOOD)).fetch,
    });
    const result = await skill.run(
      input({
        cuisine: c.cuisine,
        request: c.request,
        rerank: true,
        ...(c.budget ? { budget: c.budget } : {}),
      }),
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "unavailable") return;
    expectValid(result.data);
    expect(result.data.places.map((p) => [p.name, p.reason])).toEqual(expected[c.name]);
  });

  it("every fixture is used by a case", () => {
    const names = new Set(RERANK_CASES.map((c) => c.name));
    expect(Object.values(rerankFixture.replies).every((r) => names.has(r.case))).toBe(true);
    expect(Object.keys(rerankFixture.replies)).toHaveLength(RERANK_CASES.length);
  });
});

// Real Places responses, once scripts/record-places.ts has been run with a Maps key.
const livePath = join(import.meta.dirname, "fixtures/places-live.json");
describe.skipIf(!existsSync(livePath))("food skill: recorded Places responses", () => {
  const live = existsSync(livePath)
    ? (JSON.parse(readFileSync(livePath, "utf8")) as PlacesLiveFixture)
    : { cases: [] };
  it.each(live.cases)("$name", async (c) => {
    const skill = createFoodSkill({
      mapsKey: "k",
      fetch: fakeFetch(() => new Response(c.response, { status: c.status })).fetch,
    });
    const result = await skill.run(input({ ...c.input, rerank: false }), ctx());
    expect(result.status).toBe("ok");
    if (result.status === "unavailable") return;
    expectValid(result.data);
    expect(result.data.places.length).toBeGreaterThan(0);
  });
});

describe("food skill: input", () => {
  it("has a sensible timeout and name", () => {
    const skill = createFoodSkill({ mapsKey: "k" });
    expect(skill.name).toBe("food");
    expect(skill.timeoutMs).toBeGreaterThan(5000);
    expect(skill.timeoutMs).toBeLessThanOrEqual(15000);
  });

  it.each([
    ["no origin", { request: "x", rerank: false }],
    ["bad latitude", { origin: { ...COLUMBIA, latitude: 91 }, request: "x", rerank: false }],
    ["no rerank flag", { origin: COLUMBIA, request: "x" }],
    ["no request", { origin: COLUMBIA, rerank: true }],
    ["unknown budget", { origin: COLUMBIA, request: "x", rerank: true, budget: "cheap" }],
    ["cuisine not a list", { origin: COLUMBIA, request: "x", rerank: true, cuisine: "ramen" }],
  ])("rejects %s", (_label, raw) => {
    const skill = createFoodSkill({ mapsKey: "k" });
    expect(skill.input.safeParse(raw).success).toBe(false);
  });

  it("applies defaults", () => {
    expect(FoodInput.parse({ origin: COLUMBIA, request: "x", rerank: true })).toMatchObject({
      cuisine: [],
      openNow: false,
    });
  });
});
