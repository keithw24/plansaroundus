import { describe, expect, it } from "vitest";
import { ConfigError, describeMissing, loadConfig } from "../src/config.ts";

const issuesOf = (env: Record<string, string>): string[] => {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  throw new Error("expected loadConfig to throw");
};

describe("loadConfig", () => {
  it("starts with an empty env on the terminal channel and reports what's missing", () => {
    const config = loadConfig({});
    expect(config.chat).toEqual({ provider: "terminal" });
    expect(config.port).toBe(8787);
    expect(config.gemini).toBeNull();
    expect(config.mapsKey).toBeNull();
    expect(config.missing).toEqual([
      "GEMINI_API_KEY",
      "GOOGLE_MAPS_API_KEY",
      "DATABASE_URL",
      "RESEND_API_KEY",
      "SITE_AUTH_SECRET",
    ]);
    expect(describeMissing(config)).toBe(
      "Running without: GEMINI_API_KEY, GOOGLE_MAPS_API_KEY, DATABASE_URL, RESEND_API_KEY, SITE_AUTH_SECRET",
    );
    expect(config.skillsMissing).toEqual({
      safety: ["DATABASE_URL"],
      events: ["DATABASE_URL"],
      food: ["GOOGLE_MAPS_API_KEY"],
      route: [],
    });
  });

  it("treats blank values as unset", () => {
    const config = loadConfig({ GEMINI_API_KEY: "  ", PORT: "", CHAT_PROVIDER: "" });
    expect(config.gemini).toBeNull();
    expect(config.port).toBe(8787);
    expect(config.chat.provider).toBe("terminal");
  });

  it("builds grouped config when keys are set", () => {
    const config = loadConfig({
      GEMINI_API_KEY: "g",
      GOOGLE_MAPS_API_KEY: "m",
      DATABASE_URL: "postgres://u:p@host:5432/db",
      RESEND_API_KEY: "r",
      RESEND_FROM: "Around Us <hi@example.com>",
      SITE_AUTH_SECRET: "x".repeat(32),
      SITE_ORIGINS: "https://aroundus.nyc, http://localhost:3000",
      PORT: "9000",
    });
    expect(config.gemini).toEqual({ apiKey: "g", model: "gemini-flash-latest" });
    expect(config.site.origins).toEqual(["https://aroundus.nyc", "http://localhost:3000"]);
    expect(config.port).toBe(9000);
    expect(config.missing).toEqual([]);
    expect(describeMissing(config)).toBeNull();
    expect(Object.values(config.skillsMissing).flat()).toEqual([]);
  });

  it("refuses to start photon half-configured", () => {
    const issues = issuesOf({ CHAT_PROVIDER: "photon", PHOTON_PROJECT_ID: "p" });
    expect(issues).toEqual([
      "PHOTON_API_KEY: required when CHAT_PROVIDER=photon",
      "DATABASE_URL: required when CHAT_PROVIDER=photon",
    ]);
  });

  it("accepts a fully configured photon channel", () => {
    const config = loadConfig({
      CHAT_PROVIDER: "photon",
      PHOTON_PROJECT_ID: "p",
      PHOTON_API_KEY: "k",
      DATABASE_URL: "postgresql://localhost/db",
    });
    expect(config.chat).toEqual({ provider: "photon", projectId: "p", apiKey: "k" });
  });

  it("fails on unknown flags", () => {
    expect(issuesOf({ FLAGS_OFF: "compose.gemni" })).toEqual([
      'FLAGS_OFF: unknown flag "compose.gemni"',
    ]);
  });

  it("collects every problem at once", () => {
    const issues = issuesOf({
      CHAT_PROVIDER: "imessage",
      PORT: "99999",
      DATABASE_URL: "mysql://nope",
      SITE_AUTH_SECRET: "short",
    });
    expect(issues).toHaveLength(4);
  });

  it("reports schema errors and cross-field errors together", () => {
    expect(issuesOf({ PORT: "99999", FLAGS_OFF: "skill.fod" })).toHaveLength(2);
    expect(issuesOf({ CHAT_PROVIDER: "photon", SITE_AUTH_SECRET: "short" })).toHaveLength(4);
  });

  it("accepts only plain whole-number ports", () => {
    for (const PORT of ["0x1F90", "1e3", "8080.0", "-1", "0"]) {
      expect(issuesOf({ PORT })).toHaveLength(1);
    }
    expect(loadConfig({ PORT: " 8080 " }).port).toBe(8080);
  });

  it("trims every value", () => {
    const config = loadConfig({
      NODE_ENV: " production ",
      GEMINI_API_KEY: "g",
      GEMINI_MODEL: " m ",
    });
    expect(config.env).toBe("production");
    expect(config.gemini?.model).toBe("m");
  });

  it("normalizes origins and rejects ones with a path", () => {
    const config = loadConfig({ SITE_ORIGINS: "https://AroundUs.nyc/,https://x.com:443" });
    expect(config.site.origins).toEqual(["https://aroundus.nyc", "https://x.com"]);
    expect(issuesOf({ SITE_ORIGINS: "https://aroundus.nyc/signup" })).toHaveLength(1);
  });

  it("rejects Resend without a sender", () => {
    expect(issuesOf({ RESEND_API_KEY: "r" })).toEqual([
      "RESEND_FROM: required when RESEND_API_KEY is set",
    ]);
  });
});
