import { createHash } from "node:crypto";

/**
 * Recorded Gemini replies are keyed by everything sent: system prompt, prompt
 * (message and recent lines) and JSON schema. Changing any of them misses the
 * fixture, so a stale recording can't pass silently.
 */
export function fixtureKey(req: { system: string; prompt: string; jsonSchema: unknown }): string {
  return createHash("sha256")
    .update(JSON.stringify([req.system, req.prompt, req.jsonSchema]))
    .digest("hex")
    .slice(0, 16);
}

export type IntentFixture = {
  model: string;
  recordedAt: string;
  replies: Record<string, { message: string; reply: string }>;
};
