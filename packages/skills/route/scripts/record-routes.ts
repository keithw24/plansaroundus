// Records live computeRoutes responses, so tests can check the real shape
// offline. Run: npm run record:routes -w @aroundus/skill-route
// Needs GOOGLE_MAPS_API_KEY with the Routes API enabled. Runs the skill itself
// through a recording fetch, so the request is exactly what production sends,
// and exits non-zero if any case doesn't come back `ok` with a duration.
// Writes test/fixtures/routes-recorded.json; route.test.ts replays it if present.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger, loadConfig, type RouteInput } from "@aroundus/core";
import { createRouteSkill } from "../src/index.ts";
import type { RecordedCase } from "../test/recorded.ts";

const config = loadConfig(process.env);
if (!config.mapsKey) throw new Error("GOOGLE_MAPS_API_KEY is not set");

// Fixed public NYC landmarks, never user locations.
const COLUMBIA = { label: "Columbia University", latitude: 40.8075, longitude: -73.9626 };
const HARLEM = { label: "Apollo Theater", latitude: 40.81, longitude: -73.95 };
const WALL_ST = { label: "Wall Street", latitude: 40.7064, longitude: -74.0094 };
const departureTime = new Date(Date.now() + 15 * 60_000).toISOString();

const CASES: { name: string; input: RouteInput }[] = [
  {
    name: "walk",
    input: { origin: COLUMBIA, destination: HARLEM, travelMode: "WALK", departureTime },
  },
  {
    name: "bicycle",
    input: { origin: COLUMBIA, destination: HARLEM, travelMode: "BICYCLE", departureTime },
  },
  {
    name: "drive",
    input: { origin: COLUMBIA, destination: WALL_ST, travelMode: "DRIVE", departureTime },
  },
  {
    name: "transit-short",
    input: { origin: COLUMBIA, destination: HARLEM, travelMode: "TRANSIT", departureTime },
  },
  {
    name: "transit-long",
    input: { origin: COLUMBIA, destination: WALL_ST, travelMode: "TRANSIT", departureTime },
  },
];
// A place id destination too, when given: ROUTE_PLACE_ID=ChIJ... (any NYC place).
const placeId = process.env.ROUTE_PLACE_ID;
if (placeId) {
  CASES.push({
    name: "walk-place-id",
    input: {
      origin: COLUMBIA,
      destination: { ...HARLEM, placeId },
      travelMode: "WALK",
      departureTime,
    },
  });
}

const recorded: RecordedCase[] = [];
let failures = 0;
for (const c of CASES) {
  let body: string | undefined;
  const recording: typeof fetch = async (url, init) => {
    const res = await fetch(url, init);
    body = await res.clone().text();
    return res;
  };
  const skill = createRouteSkill({ mapsKey: config.mapsKey, fetch: recording });
  const result = await skill.run(c.input, {
    now: new Date(),
    signal: AbortSignal.timeout(skill.timeoutMs),
    log: createLogger({ level: "debug" }),
  });
  const ok = result.status === "ok" && result.data.durationMinutes !== undefined;
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${c.name}: ${result.status}`,
    result.data ? JSON.stringify({ ...result.data, directionsUrl: undefined }) : "",
    result.warnings.join(" "),
  );
  if (ok && body !== undefined) {
    recorded.push({
      name: c.name,
      input: c.input,
      response: JSON.parse(body),
      expected: result.data,
    });
  }
}

const out = join(import.meta.dirname, "../test/fixtures/routes-recorded.json");
writeFileSync(
  out,
  `${JSON.stringify({ recordedAt: new Date().toISOString(), cases: recorded }, null, 2)}\n`,
);
console.log(`\nwrote ${recorded.length} responses to ${out}; ${failures} failed`);
if (failures > 0) process.exitCode = 1;
