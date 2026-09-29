// Records live Gemini replies for the intent routing table, so tests can
// replay them offline. Run: npm run record:intents -w @aroundus/router
// Exits non-zero if Gemini disagrees with the table's expected needs.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLlm, type Generate, geminiGenerate, loadConfig, silentLogger } from "@aroundus/core";
import { INTENT_TIMEOUT_MS, parseIntent } from "../src/intent.ts";
import { fixtureKey, type IntentFixture } from "../test/fixture-key.ts";
import { INTENT_CASES } from "../test/intent-cases.ts";

const config = loadConfig(process.env);
if (!config.gemini) throw new Error("GEMINI_API_KEY is not set");
const { model } = config.gemini;
const live = geminiGenerate(config.gemini);

// Each reply is stored under its own request's key, so a late reply from a
// timed-out attempt can't land under the wrong case.
const byKey = new Map<string, string>();
const recording: Generate = async (req) => {
  const reply = await live(req);
  byKey.set(fixtureKey(req), reply);
  return reply;
};
const llm = createLlm(recording);
const PACE_MS = 4_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const flags = { enabled: () => true };
const replies: IntentFixture["replies"] = {};

let mismatches = 0;
for (const c of INTENT_CASES) {
  for (let attempt = 1; ; attempt++) {
    byKey.clear();
    // The production timeout, so a fixture never holds a reply the agent would have dropped.
    const result = await parseIntent({
      text: c.text,
      recent: c.recent ?? [],
      flags,
      llm,
      log: silentLogger,
      timeoutMs: INTENT_TIMEOUT_MS,
    });
    const [entry] = byKey;
    if (result.source === "gemini" && entry) {
      replies[entry[0]] = { message: c.text, reply: entry[1] };
      const ok = JSON.stringify(result.intent.needs) === JSON.stringify(c.needs);
      if (!ok) mismatches++;
      console.log(
        `${ok ? "ok  " : "DIFF"} ${c.text} → ${result.intent.needs.join(",") || "(none)"}`,
      );
      break;
    }
    // 503s, rate limits and timeouts are common; back off and retry.
    if (attempt === 6) throw new Error(`gave up on "${c.text}" (${result.fallback})`);
    await sleep(5_000 * attempt);
  }
  // Free-tier keys have a per-minute limit; pace the calls.
  await sleep(PACE_MS);
}

const out = join(import.meta.dirname, "../test/fixtures/intent-gemini.json");
const fixture: IntentFixture = { model, recordedAt: new Date().toISOString(), replies };
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(
  `\nwrote ${Object.keys(replies).length} replies from ${model}; ${mismatches} differ from the table`,
);
if (mismatches > 0) process.exitCode = 1;
