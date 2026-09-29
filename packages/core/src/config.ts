import { z } from "zod";
import type { SkillName } from "./contracts.ts";
import { type FlagSettings, parseFlagSettings } from "./flags.ts";
import { LOG_LEVELS, type LogLevel } from "./logger.ts";

// Every value is trimmed, and blank ("GEMINI_API_KEY=") counts as unset.
const blankToUndefined = (v: unknown) => {
  if (typeof v !== "string") return v;
  const t = v.trim();
  return t === "" ? undefined : t;
};
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(blankToUndefined, schema.optional());
const withDefault = <T extends z.ZodType>(schema: T, fallback: z.input<T>) =>
  z.preprocess((v) => blankToUndefined(v) ?? fallback, schema);

const Env = z.object({
  NODE_ENV: withDefault(z.enum(["development", "test", "production"]), "development"),
  LOG_LEVEL: withDefault(z.enum(LOG_LEVELS), "info"),
  PORT: withDefault(
    z
      .string()
      .regex(/^\d+$/, "must be a whole number")
      .transform(Number)
      .pipe(z.number().int().min(1).max(65535)),
    "8787",
  ),

  /** How long to wait for follow-up messages before answering ("dinner" … "near columbia"). */
  INBOX_BATCH_MS: withDefault(
    z
      .string()
      .regex(/^\d+$/, "must be a whole number")
      .transform(Number)
      .pipe(z.number().int().max(30_000)),
    "2000",
  ),
  CHAT_PROVIDER: withDefault(z.enum(["terminal", "photon"]), "terminal"),
  PHOTON_PROJECT_ID: optional(z.string()),
  PHOTON_API_KEY: optional(z.string()),

  GEMINI_API_KEY: optional(z.string()),
  GEMINI_MODEL: withDefault(z.string(), "gemini-flash-latest"),
  GOOGLE_MAPS_API_KEY: optional(z.string()),
  DATABASE_URL: optional(z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// URL")),
  /** Keys chat ids with HMAC before storing, so stored keys can't be reversed into phone numbers. */
  CHAT_KEY_SECRET: optional(z.string().min(32, "must be at least 32 characters")),

  RESEND_API_KEY: optional(z.string()),
  RESEND_FROM: optional(z.string()),
  SITE_AUTH_SECRET: optional(z.string().min(32, "must be at least 32 characters")),
  SITE_ORIGINS: optional(z.string()),

  FLAGS_ON: optional(z.string()),
  FLAGS_OFF: optional(z.string()),
  FLAGS_BETA: optional(z.string()),
  FLAGS_BETA_PHONES: optional(z.string()),
});
type Env = z.output<typeof Env>;

/** Keys the agent can run without, each switching off something specific. */
const OPTIONAL_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_MAPS_API_KEY",
  "DATABASE_URL",
  "RESEND_API_KEY",
  "SITE_AUTH_SECRET",
] as const;

/**
 * What each skill needs configured to run at all. Route has no hard need:
 * without a Maps key it still returns a directions link, just no duration.
 */
const SKILL_NEEDS: Record<SkillName, readonly (typeof OPTIONAL_KEYS)[number][]> = {
  safety: ["DATABASE_URL"],
  events: ["DATABASE_URL"],
  food: ["GOOGLE_MAPS_API_KEY"],
  route: [],
};

export type Config = {
  env: "development" | "test" | "production";
  logLevel: LogLevel;
  port: number;
  inboxBatchMs: number;
  chat: { provider: "terminal" } | { provider: "photon"; projectId: string; apiKey: string };
  gemini: { apiKey: string; model: string } | null;
  mapsKey: string | null;
  databaseUrl: string | null;
  /** Set whenever databaseUrl is. */
  chatKeySecret: string | null;
  email: { resendKey: string; from: string } | null;
  site: { authSecret: string | null; origins: string[] };
  flags: FlagSettings;
  /** Optional keys that are unset, e.g. ["GOOGLE_MAPS_API_KEY"]. */
  missing: string[];
  /** Keys each skill is missing; an empty list means it can run. */
  skillsMissing: Record<SkillName, string[]>;
};

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid config:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/**
 * Validates env into a typed Config. Apps pass in the process environment; nothing
 * in packages/ reads it directly. Throws one ConfigError listing every problem.
 */
export function loadConfig(raw: Record<string, string | undefined>): Config {
  const issues: string[] = [];

  const parsed = Env.safeParse(raw);
  if (!parsed.success) {
    issues.push(...parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }

  // Cross-field checks read the trimmed raw strings, so they run even when a
  // field above failed and every problem is reported in one go.
  const get = (key: keyof Env): string | undefined =>
    blankToUndefined(raw[key]) as string | undefined;

  const { settings: flags, errors: flagErrors } = parseFlagSettings({
    FLAGS_ON: get("FLAGS_ON"),
    FLAGS_OFF: get("FLAGS_OFF"),
    FLAGS_BETA: get("FLAGS_BETA"),
    FLAGS_BETA_PHONES: get("FLAGS_BETA_PHONES"),
  });
  issues.push(...flagErrors);

  // The live channel must be fully configured; a half-set Photon would drop messages.
  if (get("CHAT_PROVIDER") === "photon") {
    for (const key of ["PHOTON_PROJECT_ID", "PHOTON_API_KEY", "DATABASE_URL"] as const) {
      if (!get(key)) issues.push(`${key}: required when CHAT_PROVIDER=photon`);
    }
  }
  if (get("DATABASE_URL") && !get("CHAT_KEY_SECRET")) {
    issues.push("CHAT_KEY_SECRET: required when DATABASE_URL is set");
  }
  if (get("RESEND_API_KEY") && !get("RESEND_FROM")) {
    issues.push("RESEND_FROM: required when RESEND_API_KEY is set");
  }

  const origins: string[] = [];
  for (const entry of (get("SITE_ORIGINS") ?? "").split(",")) {
    const value = entry.trim();
    if (!value) continue;
    const origin = toOrigin(value);
    if (origin) origins.push(origin);
    else issues.push(`SITE_ORIGINS: "${value}" is not an origin like https://example.com`);
  }

  if (issues.length > 0 || !parsed.success) throw new ConfigError(issues);
  const env = parsed.data;

  const chat: Config["chat"] =
    env.CHAT_PROVIDER === "photon" && env.PHOTON_PROJECT_ID && env.PHOTON_API_KEY
      ? { provider: "photon", projectId: env.PHOTON_PROJECT_ID, apiKey: env.PHOTON_API_KEY }
      : { provider: "terminal" };
  const missing = OPTIONAL_KEYS.filter((key) => !env[key]);

  return {
    env: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    port: env.PORT,
    inboxBatchMs: env.INBOX_BATCH_MS,
    chat,
    gemini: env.GEMINI_API_KEY ? { apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL } : null,
    mapsKey: env.GOOGLE_MAPS_API_KEY ?? null,
    databaseUrl: env.DATABASE_URL ?? null,
    chatKeySecret: env.CHAT_KEY_SECRET ?? null,
    email:
      env.RESEND_API_KEY && env.RESEND_FROM
        ? { resendKey: env.RESEND_API_KEY, from: env.RESEND_FROM }
        : null,
    site: { authSecret: env.SITE_AUTH_SECRET ?? null, origins },
    flags,
    missing,
    skillsMissing: {
      safety: SKILL_NEEDS.safety.filter((k) => missing.includes(k)),
      events: SKILL_NEEDS.events.filter((k) => missing.includes(k)),
      food: SKILL_NEEDS.food.filter((k) => missing.includes(k)),
      route: SKILL_NEEDS.route.filter((k) => missing.includes(k)),
    },
  };
}

/** "Running without: GOOGLE_MAPS_API_KEY, RESEND_API_KEY", or null when nothing is missing. */
export function describeMissing(config: Config): string | null {
  return config.missing.length > 0 ? `Running without: ${config.missing.join(", ")}` : null;
}

/** "https://AroundUs.nyc/" → "https://aroundus.nyc". Null if it has a path, query or credentials. */
function toOrigin(value: string): string | null {
  if (value.includes("?") || value.includes("#")) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}
