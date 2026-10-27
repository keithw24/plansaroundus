// Records real Places Text Search (New) responses near Columbia, so tests can
// replay them offline (test/food.test.ts picks up test/fixtures/places-live.json
// when it exists). Run: npm run record:places -w @aroundus/skill-food
// (needs GOOGLE_MAPS_API_KEY). Each case is one billed Text Search call.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, silentLogger } from "@aroundus/core";
import { createFoodSkill } from "../src/index.ts";
import { COLUMBIA, type PlacesLiveFixture } from "../test/places-fixtures.ts";

const CASES: PlacesLiveFixture["cases"][number]["input"][] = [
  { cuisine: [], openNow: false },
  { cuisine: ["ramen"], openNow: true },
  { cuisine: ["pizza"], openNow: false, budget: "low" },
];

const config = loadConfig(process.env);
if (!config.mapsKey) throw new Error("GOOGLE_MAPS_API_KEY is not set");

const cases: PlacesLiveFixture["cases"] = [];
for (const input of CASES) {
  let recorded: { status: number; response: string } | undefined;
  const recordingFetch: typeof fetch = async (url, init) => {
    const res = await fetch(url, init);
    const response = await res.text();
    recorded = { status: res.status, response };
    return new Response(response, { status: res.status, headers: res.headers });
  };
  const skill = createFoodSkill({ mapsKey: config.mapsKey, fetch: recordingFetch });
  const name = `${input.cuisine.join(" ") || "any"}${input.openNow ? " open now" : ""}${input.budget ? ` ${input.budget}` : ""}`;
  try {
    const result = await skill.run(
      { origin: COLUMBIA, request: "", rerank: false, ...input },
      { now: new Date(), signal: AbortSignal.timeout(skill.timeoutMs), log: silentLogger },
    );
    if (result.status !== "unavailable") {
      console.log(`ok   ${name} → ${result.data.places.map((p) => p.name).join(" | ")}`);
    }
  } catch (err) {
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (recorded) cases.push({ name, input, ...recorded });
}

const out = join(import.meta.dirname, "../test/fixtures/places-live.json");
const fixture: PlacesLiveFixture = { recordedAt: new Date().toISOString(), cases };
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`\nwrote ${cases.length} Places responses`);
