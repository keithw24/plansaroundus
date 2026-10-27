import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { silentLogger } from "@aroundus/core";
import { describe, expect, it } from "vitest";
import { createRouteSkill } from "../src/index.ts";
import type { RecordedFile } from "./recorded.ts";

// Replays real responses from `npm run record:routes -w @aroundus/skill-route`.
// None exist until a Maps key does, so this suite is skipped until then.
const path = join(import.meta.dirname, "fixtures/routes-recorded.json");
const file: RecordedFile | null = existsSync(path)
  ? (JSON.parse(readFileSync(path, "utf8")) as RecordedFile)
  : null;

describe.skipIf(!file)("recorded Routes responses", () => {
  for (const c of file?.cases ?? []) {
    it(`${c.name} replays to what the skill returned live`, async () => {
      const fetch = (async () =>
        new Response(JSON.stringify(c.response))) as typeof globalThis.fetch;
      const skill = createRouteSkill({ mapsKey: "replay", fetch });
      const res = await skill.run(c.input, {
        now: new Date(file?.recordedAt ?? 0),
        signal: new AbortController().signal,
        log: silentLogger,
      });
      expect(res.status).toBe("ok");
      expect(res.data).toEqual(c.expected);
    });
  }
});
