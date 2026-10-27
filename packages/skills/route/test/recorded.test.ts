import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { silentLogger } from "@aroundus/core";
import { describe, expect, it } from "vitest";
import { createRouteSkill } from "../src/index.ts";
import type { RecordedFile } from "./recorded.ts";

// Replays real exchanges from `npm run record:routes -w @aroundus/skill-route`.
// None exist until a Maps key does, so this suite is skipped until then.
const path = join(import.meta.dirname, "fixtures/routes-recorded.json");
const file: RecordedFile | null = existsSync(path)
  ? (JSON.parse(readFileSync(path, "utf8")) as RecordedFile)
  : null;

describe.skipIf(!file)("recorded Routes exchanges", () => {
  for (const c of file?.cases ?? []) {
    it(`${c.name}: same request, same result`, async () => {
      const sent: { fieldMask: string; body: unknown }[] = [];
      const replay = (async (_url: unknown, init?: RequestInit) => {
        sent.push({
          fieldMask: new Headers(init?.headers).get("X-Goog-FieldMask") ?? "",
          body: JSON.parse(String(init?.body)),
        });
        return new Response(c.responseText, { status: c.httpStatus });
      }) as typeof fetch;
      const skill = createRouteSkill({ mapsKey: "replay", fetch: replay });
      const res = await skill.run(c.input, {
        now: new Date(c.now),
        signal: new AbortController().signal,
        log: silentLogger,
      });
      expect(sent).toEqual([c.request]);
      expect({ status: res.status, data: res.data, warnings: res.warnings }).toEqual(c.expected);
    });
  }
});
