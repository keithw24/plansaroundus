import { z } from "zod";
import { type FlagSettings, parseFlagSettings } from "./flags.ts";
import { LOG_LEVELS, type LogLevel } from "./logger.ts";

// Blank values in .env ("GEMINI_API_KEY=") count as unset.
const optionalString = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().trim().optional(),
);
const withDefault = <T extends z.ZodType>(schema: T, fallback: z.input<T>) =>
  z.preprocess(
    (v) => (v === undefined || (typeof v === "string" && v.trim() === "") ? fallback : v),
    schema,
  );

const Env = z.object({
  NODE_ENV: withDefault(z.enum(["development", "test", "production"]), "development"),
  LOG_LEVEL: withDefault(z.enum(LOG_LEVELS), "info"),
  PORT: withDefault(z.coerce.number().int().min(1).max(65535), "8787"),

  CHAT_PROVIDER: withDefault(z.enum(["terminal", "photon"]), "terminal"),
  PHOTON_PROJECT_ID: optionalString,
  PHOTON_API_KEY: optionalString,

  GEMINI_API_KEY: optionalString,
  GEMINI_MODEL: withDefault(z.string().min(1), "gemini-flash-latest"),
  GOOGLE_MAPS_API_KEY: optionalString,
  DATABASE_URL: optionalString.pipe(
    z
      .string()
      .regex(/^postgres(ql)?:\/\//, "must be a postgres:// URL")
      .optional(),
  ),

  RESEND_API_KEY: optionalString,
  RESEND_FROM: optionalString,
  SITE_AUTH_SECRET: optionalString.pipe(
    z.string().min(32, "must be at least 32 characters").optional(),
  ),
  SITE_ORIGINS: optionalString,

  FLAGS_ON: optionalString,
  FLAGS_OFF: optionalString,
  FLAGS_BETA: optionalString,
  FLAGS_BETA_PHONES: optionalString,
});

/** Keys the agent can run without, each switching off something specific. */
const OPTIONAL_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_MAPS_API_KEY",
  "DATABASE_URL",
  "RESEND_API_KEY",
  "SITE_AUTH_SECRET",
] as const;

export type Config = {
  env: "development" | "test" | "production";
  logLevel: LogLevel;
  port: number;
  chat: { provider: "terminal" } | { provider: "photon"; projectId: string; apiKey: string };
  gemini: { apiKey: string; model: string } | null;
  mapsKey: string | null;
  databaseUrl: string | null;
  email: { resendKey: string; from: string } | null;
  site: { authSecret: string | null; origins: string[] };
  flags: FlagSettings;
  /** Optional keys that are unset, e.g. ["GOOGLE_MAPS_API_KEY"]. */
  missing: string[];
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
 * Validates env into a typed Config. Pass `process.env` from an app; nothing
 * in packages/ reads it directly. Throws ConfigError listing every problem.
 */
export function loadConfig(raw: Record<string, string | undefined>): Config {
  const parsed = Env.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  const env = parsed.data;
  const issues: string[] = [];

  const { settings: flags, errors: flagErrors } = parseFlagSettings(env);
  issues.push(...flagErrors);

  // The live channel must be fully configured; a half-set Photon would drop messages.
  let chat: Config["chat"] = { provider: "terminal" };
  if (env.CHAT_PROVIDER === "photon") {
    const needed = {
      PHOTON_PROJECT_ID: env.PHOTON_PROJECT_ID,
      PHOTON_API_KEY: env.PHOTON_API_KEY,
      DATABASE_URL: env.DATABASE_URL,
    };
    for (const [key, value] of Object.entries(needed)) {
      if (!value) issues.push(`${key}: required when CHAT_PROVIDER=photon`);
    }
    if (env.PHOTON_PROJECT_ID && env.PHOTON_API_KEY) {
      chat = { provider: "photon", projectId: env.PHOTON_PROJECT_ID, apiKey: env.PHOTON_API_KEY };
    }
  }

  if (env.RESEND_API_KEY && !env.RESEND_FROM)
    issues.push("RESEND_FROM: required when RESEND_API_KEY is set");

  const origins = (env.SITE_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const origin of origins) {
    if (!isOrigin(origin))
      issues.push(`SITE_ORIGINS: "${origin}" is not an origin like https://example.com`);
  }

  if (issues.length > 0) throw new ConfigError(issues);

  return {
    env: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    port: env.PORT,
    chat,
    gemini: env.GEMINI_API_KEY ? { apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL } : null,
    mapsKey: env.GOOGLE_MAPS_API_KEY ?? null,
    databaseUrl: env.DATABASE_URL ?? null,
    email:
      env.RESEND_API_KEY && env.RESEND_FROM
        ? { resendKey: env.RESEND_API_KEY, from: env.RESEND_FROM }
        : null,
    site: { authSecret: env.SITE_AUTH_SECRET ?? null, origins },
    flags,
    missing: OPTIONAL_KEYS.filter((key) => !env[key]),
  };
}

/** "Running without: GOOGLE_MAPS_API_KEY, RESEND_API_KEY", or null when nothing is missing. */
export function describeMissing(config: Config): string | null {
  return config.missing.length > 0 ? `Running without: ${config.missing.join(", ")}` : null;
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
  } catch {
    return false;
  }
}
