// Records live Gemini replies for the intent routing table, so tests can
// replay them offline. Run: npm run record:intents -w @aroundus/router
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createLlm,
  type Generate,
  geminiGenerate,
  LlmError,
  loadConfig,
  silentLogger,
} from "@aroundus/core";
import { parseIntent } from "../src/intent.ts";
import { INTENT_CASES } from "../test/intent-cases.ts";

const config = loadConfig(process.env);
if (!config.gemini) throw new Error("GEMINI_API_KEY is not set");
const { model } = config.gemini;
const live = geminiGenerate(config.gemini);

const replies: Record<string, string> = {};
let lastRaw = "";
const recording: Generate = async (req) => {
  lastRaw = await live(req);
  return lastRaw;
};
const llm = createLlm(recording);
const flags = { enabled: () => true };

let mismatches = 0;
for (const c of INTENT_CASES) {
  for (let attempt = 1; ; attempt++) {
    const result = await parseIntent({
      text: c.text,
      recent: c.recent ?? [],
      flags,
      llm,
      log: silentLogger,
      timeoutMs: 30_000,
    });
    if (result.source === "gemini") {
      replies[c.text] = lastRaw;
      const ok = JSON.stringify(result.intent.needs) === JSON.stringify(c.needs);
      if (!ok) mismatches++;
      console.log(
        `${ok ? "ok  " : "DIFF"} ${c.text} → ${result.intent.needs.join(",") || "(none)"}`,
      );
      break;
    }
    // 503s and timeouts are common; back off and retry.
    if (attempt === 5)
      throw new LlmError("provider", `gave up on "${c.text}" (${result.fallback})`);
    await new Promise((r) => setTimeout(r, 2_000 * attempt));
  }
}

const out = join(import.meta.dirname, "../test/fixtures/intent-gemini.json");
writeFileSync(
  out,
  `${JSON.stringify({ model, recordedAt: new Date().toISOString(), replies }, null, 2)}\n`,
);
console.log(
  `\nwrote ${Object.keys(replies).length} replies from ${model}; ${mismatches} differ from the table`,
);
