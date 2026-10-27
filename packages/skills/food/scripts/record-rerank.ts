// Records live Gemini re-rank replies over the hand-built Places candidates in
// test/places-fixtures.ts, so tests can replay them offline.
// Run: npm run record:rerank -w @aroundus/skill-food (needs GEMINI_API_KEY).
// Re-record after changing the re-rank prompt, schema or the candidates.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLlm, type Generate, geminiGenerate, loadConfig, silentLogger } from "@aroundus/core";
import { createFoodSkill } from "../src/index.ts";
import {
  COLUMBIA,
  fakeFetch,
  fixtureKey,
  NEIGHBORHOOD,
  placesResponse,
  RERANK_CASES,
  type RerankFixture,
} from "../test/places-fixtures.ts";

const config = loadConfig(process.env);
if (!config.gemini) throw new Error("GEMINI_API_KEY is not set");
const { model } = config.gemini;
const live = geminiGenerate(config.gemini);

// A hard cap on model calls, retries included.
const MAX_CALLS = 3;
let calls = 0;
const byKey = new Map<string, string>();
const recording: Generate = async (req) => {
  if (++calls > MAX_CALLS) throw new Error(`call budget of ${MAX_CALLS} used up`);
  const reply = await live(req);
  byKey.set(fixtureKey(req), reply);
  return reply;
};
const skill = createFoodSkill({
  mapsKey: "unused",
  llm: createLlm(recording),
  fetch: fakeFetch(() => placesResponse(NEIGHBORHOOD)).fetch,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const replies: RerankFixture["replies"] = {};

for (const c of RERANK_CASES) {
  for (let attempt = 1; ; attempt++) {
    byKey.clear();
    const result = await skill.run(
      {
        origin: COLUMBIA,
        cuisine: c.cuisine,
        ...(c.budget ? { budget: c.budget } : {}),
        openNow: false,
        request: c.request,
        rerank: true,
      },
      { now: new Date(), signal: AbortSignal.timeout(skill.timeoutMs), log: silentLogger },
    );
    const [entry] = byKey;
    if (result.status === "ok" && entry) {
      replies[entry[0]] = { case: c.name, reply: entry[1] };
      console.log(
        `ok   ${c.name} → ${result.data.places.map((p) => `${p.name}${p.reason ? ` (${p.reason})` : ""}`).join(" | ")}`,
      );
      break;
    }
    if (attempt === 2 || calls >= MAX_CALLS) throw new Error(`gave up on "${c.name}"`);
    await sleep(5_000);
  }
  await sleep(4_000);
}

const out = join(import.meta.dirname, "../test/fixtures/rerank-gemini.json");
const fixture: RerankFixture = { model, recordedAt: new Date().toISOString(), replies };
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`\nwrote ${Object.keys(replies).length} replies from ${model} in ${calls} calls`);
