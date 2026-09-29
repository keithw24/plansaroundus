import { normalizePhone, normalizeSender } from "./phone.ts";

export const FLAGS = {
  "skill.safety": { default: true, about: "NYPD history" },
  "skill.events": { default: true, about: "NYC Parks + permitted events" },
  "skill.food": { default: true, about: "Google Places restaurants" },
  "skill.route": { default: true, about: "Google Routes travel times" },
  "intent.gemini": { default: true, about: "Off = keyword intent parser only" },
  "compose.gemini": { default: true, about: "Off = template replies only" },
  "food.gemini_rank": { default: true, about: "Off = Places order, no re-rank" },
  "events.tavily": { default: false, about: "Web enrichment for events" },
  "chat.groups": { default: false, about: "Answer @agent in group chats" },
  "site.signup": { default: true, about: "Website sign-up open" },
} as const satisfies Record<string, { default: boolean; about: string }>;

export type FlagName = keyof typeof FLAGS;
export type FlagState = "on" | "off" | "beta";

export type FlagSettings = {
  on: FlagName[];
  off: FlagName[];
  beta: FlagName[];
  /** E.164 numbers, already normalized. */
  betaPhones: string[];
};

export type FlagEnv = {
  FLAGS_ON?: string | undefined;
  FLAGS_OFF?: string | undefined;
  FLAGS_BETA?: string | undefined;
  FLAGS_BETA_PHONES?: string | undefined;
};

/** Flags as seen by one sender. Built once per turn and passed down. */
export interface SenderFlags {
  enabled(name: FlagName): boolean;
}

export interface Flags {
  /**
   * Beta flags are on only for beta senders. `sender` is required so no call
   * site can forget it; pass null when there is no sender (startup, jobs).
   */
  enabled(name: FlagName, ctx: { sender: string | null }): boolean;
  forSender(sender: string | null): SenderFlags;
  /** Effective state of every flag, for /healthz. */
  effective(): Record<FlagName, FlagState>;
}

export function isFlagName(name: string): name is FlagName {
  return Object.hasOwn(FLAGS, name);
}

/** Parses FLAGS_* env vars. Unknown names, bad phones and conflicts are errors, never ignored. */
export function parseFlagSettings(env: FlagEnv): { settings: FlagSettings; errors: string[] } {
  const errors: string[] = [];
  const names = (key: keyof FlagEnv): FlagName[] => {
    const out: FlagName[] = [];
    for (const name of splitList(env[key])) {
      if (isFlagName(name)) out.push(name);
      else errors.push(`${key}: unknown flag "${name}"`);
    }
    return out;
  };

  const settings: FlagSettings = {
    on: names("FLAGS_ON"),
    off: names("FLAGS_OFF"),
    beta: names("FLAGS_BETA"),
    betaPhones: [],
  };

  const seen = new Map<FlagName, string>();
  for (const key of ["on", "off", "beta"] as const) {
    for (const name of settings[key]) {
      const prev = seen.get(name);
      if (prev && prev !== key)
        errors.push(
          `flag "${name}" is in both FLAGS_${prev.toUpperCase()} and FLAGS_${key.toUpperCase()}`,
        );
      seen.set(name, key);
    }
  }

  for (const raw of splitList(env.FLAGS_BETA_PHONES)) {
    const phone = normalizePhone(raw);
    if (phone) settings.betaPhones.push(phone);
    else errors.push(`FLAGS_BETA_PHONES: "${raw}" is not a phone number`);
  }
  if (settings.beta.length > 0 && settings.betaPhones.length === 0) {
    errors.push(
      "FLAGS_BETA is set but FLAGS_BETA_PHONES is empty, so those flags would be off for everyone",
    );
  }

  return { settings, errors };
}

export function createFlags(settings: FlagSettings): Flags {
  const state = new Map<FlagName, FlagState>();
  for (const name of Object.keys(FLAGS) as FlagName[]) {
    state.set(name, FLAGS[name].default ? "on" : "off");
  }
  for (const name of settings.on) state.set(name, "on");
  for (const name of settings.off) state.set(name, "off");
  for (const name of settings.beta) state.set(name, "beta");

  const betaPhones = new Set(settings.betaPhones);
  const isBetaSender = (sender: string | null) => {
    const normalized = sender ? normalizeSender(sender) : null;
    return normalized !== null && betaPhones.has(normalized);
  };
  const check = (name: FlagName, beta: boolean) => {
    const s = state.get(name);
    if (s === undefined) throw new Error(`unknown flag "${name}"`);
    return s === "beta" ? beta : s === "on";
  };

  return {
    enabled: (name, { sender }) => check(name, isBetaSender(sender)),
    forSender(sender) {
      const beta = isBetaSender(sender);
      return { enabled: (name) => check(name, beta) };
    },
    effective: () => Object.fromEntries(state) as Record<FlagName, FlagState>,
  };
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
