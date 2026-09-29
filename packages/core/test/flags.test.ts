import { describe, expect, it } from "vitest";
import { createFlags, FLAGS, parseFlagSettings } from "../src/flags.ts";
import { normalizePhone, normalizeSender } from "../src/phone.ts";

const anyone = { sender: null };

const flagsFrom = (env: Parameters<typeof parseFlagSettings>[0]) => {
  const { settings, errors } = parseFlagSettings(env);
  expect(errors).toEqual([]);
  return createFlags(settings);
};

describe("flags", () => {
  it("uses registry defaults with no env", () => {
    const flags = flagsFrom({});
    expect(flags.enabled("skill.food", anyone)).toBe(true);
    expect(flags.enabled("events.tavily", anyone)).toBe(false);
    expect(Object.keys(flags.effective()).sort()).toEqual(Object.keys(FLAGS).sort());
  });

  it("FLAGS_ON and FLAGS_OFF override defaults for everyone", () => {
    const flags = flagsFrom({
      FLAGS_ON: "events.tavily",
      FLAGS_OFF: " compose.gemini , intent.gemini ",
    });
    expect(flags.enabled("events.tavily", anyone)).toBe(true);
    expect(flags.enabled("compose.gemini", anyone)).toBe(false);
    expect(flags.enabled("intent.gemini", anyone)).toBe(false);
  });

  it("FLAGS_BETA is on only for beta phones, whatever their formatting", () => {
    const flags = flagsFrom({
      FLAGS_BETA: "chat.groups",
      FLAGS_BETA_PHONES: "+19175550142,(347) 555-0199",
    });
    expect(flags.enabled("chat.groups", { sender: "+1 917-555-0142" })).toBe(true);
    expect(flags.enabled("chat.groups", { sender: "3475550199" })).toBe(true);
    expect(flags.enabled("chat.groups", { sender: "+12125550100" })).toBe(false);
    expect(flags.enabled("chat.groups", anyone)).toBe(false);
    expect(flags.effective()["chat.groups"]).toBe("beta");
  });

  it("a beta flag with a default of true is off for non-beta senders", () => {
    const flags = flagsFrom({ FLAGS_BETA: "skill.food", FLAGS_BETA_PHONES: "+19175550142" });
    expect(flags.enabled("skill.food", { sender: "+12125550100" })).toBe(false);
  });

  it("rejects unknown flag names so a typo can't silently disable something", () => {
    const { errors } = parseFlagSettings({ FLAGS_OFF: "skill.fod" });
    expect(errors).toEqual(['FLAGS_OFF: unknown flag "skill.fod"']);
  });

  it("rejects prototype keys as flag names", () => {
    expect(parseFlagSettings({ FLAGS_ON: "toString" }).errors).toHaveLength(1);
    const flags = flagsFrom({});
    expect(() => flags.enabled("toString" as never, anyone)).toThrow(/unknown flag/);
  });

  it("forSender resolves beta once for a whole turn", () => {
    const flags = flagsFrom({ FLAGS_BETA: "events.tavily", FLAGS_BETA_PHONES: "+19175550142" });
    expect(flags.forSender("+19175550142").enabled("events.tavily")).toBe(true);
    expect(flags.forSender("friend@icloud.com").enabled("events.tavily")).toBe(false);
    expect(flags.forSender(null).enabled("events.tavily")).toBe(false);
    expect(flags.forSender(null).enabled("skill.food")).toBe(true);
  });

  it("beta senders can be Apple ID emails", () => {
    const flags = flagsFrom({ FLAGS_BETA: "chat.groups", FLAGS_BETA_PHONES: "Keith@iCloud.com" });
    expect(flags.enabled("chat.groups", { sender: "keith@icloud.com" })).toBe(true);
  });

  it("an unparseable sender is simply not a beta sender", () => {
    const flags = flagsFrom({ FLAGS_BETA: "chat.groups", FLAGS_BETA_PHONES: "+19175550142" });
    expect(flags.enabled("chat.groups", { sender: "" })).toBe(false);
    expect(flags.enabled("chat.groups", { sender: "not a number" })).toBe(false);
  });

  it("a flag in all three lists reports both conflicts", () => {
    const { errors } = parseFlagSettings({
      FLAGS_ON: "chat.groups",
      FLAGS_OFF: "chat.groups",
      FLAGS_BETA: "chat.groups",
      FLAGS_BETA_PHONES: "+19175550142",
    });
    expect(errors).toHaveLength(2);
  });

  it("rejects a flag in two lists", () => {
    const { errors } = parseFlagSettings({ FLAGS_ON: "chat.groups", FLAGS_OFF: "chat.groups" });
    expect(errors[0]).toMatch(/both FLAGS_ON and FLAGS_OFF/);
  });

  it("rejects bad beta phones and beta flags with no phones", () => {
    expect(parseFlagSettings({ FLAGS_BETA_PHONES: "call me" }).errors).toHaveLength(1);
    expect(parseFlagSettings({ FLAGS_BETA: "chat.groups" }).errors[0]).toMatch(
      /FLAGS_BETA_PHONES is empty/,
    );
  });
});

describe("normalizePhone", () => {
  it.each([
    ["+19175550142", "+19175550142"],
    ["917 555 0142", "+19175550142"],
    ["1-917-555-0142", "+19175550142"],
    ["+44 20 7946 0958", "+442079460958"],
    ["5550142", null],
    ["+1917555014", null],
    ["0123456789", null],
    ["+1 212 155 0100", null],
    ["+0123456789", null],
    ["hello", null],
  ])("%s → %s", (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });
});

describe("normalizeSender", () => {
  it("lower-cases emails and normalizes phones", () => {
    expect(normalizeSender(" Friend@iCloud.com ")).toBe("friend@icloud.com");
    expect(normalizeSender("(917) 555-0142")).toBe("+19175550142");
    expect(normalizeSender("@agent")).toBeNull();
  });
});
