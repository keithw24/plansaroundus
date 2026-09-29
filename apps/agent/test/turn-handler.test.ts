import { createFlags, parseFlagSettings, silentLogger, type TurnRunner } from "@aroundus/core";
import { describe, expect, it, vi } from "vitest";
import { createMemoryContextStore } from "../src/context-store.ts";
import { APOLOGY, cannedTurn, HELP, SIGN_IN_UNAVAILABLE, WHERE_ARE_YOU } from "../src/replies.ts";
import { createTurnHandler, extractCode, mentionPattern } from "../src/turn-handler.ts";
import { dm, fakeChannel, pin } from "./fakes.ts";

function setup(
  opts: { runTurn?: TurnRunner; env?: Record<string, string>; turnTimeoutMs?: number } = {},
) {
  const { channel, sent } = fakeChannel();
  const store = createMemoryContextStore();
  const { settings, errors } = parseFlagSettings(opts.env ?? {});
  expect(errors).toEqual([]);
  const runTurn = vi.fn<TurnRunner>(opts.runTurn ?? cannedTurn);
  const verifyCode = vi.fn(async (_sender: string, code: string) => `verified ${code}`);
  const handle = createTurnHandler({
    channel,
    store,
    flags: createFlags(settings),
    runTurn,
    verifyCode,
    log: silentLogger,
    ...(opts.turnTimeoutMs ? { turnTimeoutMs: opts.turnTimeoutMs } : {}),
  });
  return { handle, sent, store, runTurn, verifyCode, channel };
}

describe("turn handler", () => {
  it("asks where you are when no location is known", async () => {
    const { handle, sent } = setup();
    await handle(dm("is it safe around me?"));
    expect(sent).toEqual([{ spaceId: "chat-1", text: WHERE_ARE_YOU }]);
  });

  it("records a shared location, then answers with help", async () => {
    const { handle, sent, store } = setup();
    await handle(dm("", { location: pin }));
    await handle(dm("hi"));
    expect(sent.map((s) => s.text)).toEqual([HELP, HELP]);
    expect((await store.get("chat-1")).lastLocation).toEqual(pin);
  });

  it("passes the location, recent lines and per-sender flags to the router", async () => {
    const { handle, runTurn } = setup({
      env: { FLAGS_BETA: "events.tavily", FLAGS_BETA_PHONES: "+19175550142" },
    });
    await handle(dm("hi", { location: pin, senderAddress: "+1 917 555 0142" }));
    await handle(dm("dinner?"));

    const first = runTurn.mock.calls[0]?.[0];
    expect(first?.lastLocation).toEqual(pin);
    expect(first?.flags.enabled("events.tavily")).toBe(true);
    const second = runTurn.mock.calls[1]?.[0];
    expect(second?.recent).toEqual([
      { role: "user", text: "hi" },
      { role: "agent", text: HELP },
    ]);
    expect(second?.flags.enabled("events.tavily")).toBe(false);
  });

  it("ignores group chats while chat.groups is off", async () => {
    const { handle, sent, store } = setup();
    await handle(dm("@agent dinner?", { isGroup: true, location: pin }));
    expect(sent).toEqual([]);
    // The pin is still remembered for later.
    expect((await store.get("chat-1")).lastLocation).toEqual(pin);
  });

  it("answers groups only when mentioned, with the mention stripped", async () => {
    const { handle, sent, runTurn } = setup({ env: { FLAGS_ON: "chat.groups" } });
    await handle(dm("dinner anyone?", { isGroup: true }));
    expect(sent).toEqual([]);
    await handle(dm("@Agent dinner near columbia", { isGroup: true }));
    expect(runTurn.mock.calls[0]?.[0].text).toBe("dinner near columbia");
    expect(sent).toHaveLength(1);
  });

  it("chat.groups as a beta flag follows the sender", async () => {
    const { handle, sent } = setup({
      env: { FLAGS_BETA: "chat.groups", FLAGS_BETA_PHONES: "+19175550142" },
    });
    await handle(dm("@agent hi", { isGroup: true, senderAddress: "+12125550100" }));
    expect(sent).toEqual([]);
    await handle(dm("@agent hi", { isGroup: true, senderAddress: "+19175550142" }));
    expect(sent).toHaveLength(1);
  });

  it("answers sign-in codes without reaching the router or chat memory", async () => {
    const { handle, sent, runTurn, verifyCode, store } = setup();
    await handle(dm("CODE 123456", { senderAddress: "+19175550142" }));
    expect(verifyCode).toHaveBeenCalledWith("+19175550142", "123456");
    expect(sent.map((s) => s.text)).toEqual(["verified 123456"]);
    expect(runTurn).not.toHaveBeenCalled();
    expect((await store.get("chat-1")).recent).toEqual([]);
  });

  it("can't verify a code with no sender", async () => {
    const { handle, sent, verifyCode } = setup();
    await handle(dm("code 123456"));
    expect(verifyCode).not.toHaveBeenCalled();
    expect(sent.map((s) => s.text)).toEqual([SIGN_IN_UNAVAILABLE]);
  });

  it("apologizes instead of going silent when the router throws", async () => {
    const { handle, sent } = setup({
      runTurn: async () => {
        throw new Error("boom");
      },
    });
    await handle(dm("hi"));
    expect(sent.map((s) => s.text)).toEqual([APOLOGY]);
  });

  it("apologizes and aborts the router when a turn takes too long", async () => {
    let signal: AbortSignal | undefined;
    const { handle, sent } = setup({
      turnTimeoutMs: 20,
      runTurn: (input) => {
        signal = input.signal;
        return new Promise(() => {});
      },
    });
    await handle(dm("hi"));
    expect(sent.map((s) => s.text)).toEqual([APOLOGY]);
    expect(signal?.aborted).toBe(true);
  });

  it("keeps only the last 6 lines", async () => {
    const { handle, store } = setup();
    for (let i = 0; i < 5; i++) await handle(dm(`message ${i}`));
    const { recent } = await store.get("chat-1");
    expect(recent).toHaveLength(6);
    expect(recent.at(-2)).toEqual({ role: "user", text: "message 4" });
  });
});

describe("turn handler: failures and edge cases", () => {
  it("a failed location save never apologizes to a group that didn't mention us", async () => {
    const { handle, sent, store } = setup({ env: { FLAGS_ON: "chat.groups" } });
    store.setLocation = async () => {
      throw new Error("db down");
    };
    await handle(dm("lol", { isGroup: true, location: pin }));
    expect(sent).toEqual([]);
  });

  it("a failed location save still answers a DM using the pin just shared", async () => {
    const { handle, sent, store, runTurn } = setup();
    store.setLocation = async () => {
      throw new Error("db down");
    };
    await handle(dm("hi", { location: pin }));
    expect(runTurn.mock.calls[0]?.[0].lastLocation).toEqual(pin);
    expect(sent.map((s) => s.text)).toEqual([HELP]);
  });

  it("a failed line save is swallowed after the reply goes out", async () => {
    const { handle, sent, store } = setup();
    store.appendLines = async () => {
      throw new Error("db down");
    };
    await handle(dm("hi", { location: pin }));
    expect(sent.map((s) => s.text)).toEqual([HELP]);
  });

  it("a stalled store read times out into an apology instead of hanging", async () => {
    const { handle, sent, store } = setup({ turnTimeoutMs: 20 });
    store.get = () => new Promise(() => {});
    await handle(dm("hi"));
    expect(sent.map((s) => s.text)).toEqual([APOLOGY]);
  });

  it("a hung send is abandoned so the chat isn't blocked", async () => {
    const { channel } = fakeChannel();
    channel.send = () => new Promise(() => {});
    const handle = createTurnHandler({
      channel,
      store: createMemoryContextStore(),
      flags: createFlags(parseFlagSettings({}).settings),
      runTurn: cannedTurn,
      log: silentLogger,
      ioTimeoutMs: 20,
    });
    await expect(handle(dm("hi"))).resolves.toBeUndefined();
  });

  it("tries to apologize when sending the reply fails", async () => {
    const { handle, channel } = setup();
    const attempts: string[] = [];
    channel.send = async (_space, text) => {
      attempts.push(text);
      throw new Error("send failed");
    };
    await handle(dm("hi"));
    expect(attempts).toEqual([WHERE_ARE_YOU, APOLOGY]);
  });

  it("a code batched with other messages is answered alone and never reaches the router", async () => {
    const { handle, sent, runTurn, store } = setup();
    await handle(dm("hi\nCODE 123456", { senderAddress: "+19175550142", location: pin }));
    expect(sent.map((s) => s.text)).toEqual(["verified 123456", HELP]);
    expect(runTurn.mock.calls[0]?.[0].text).toBe("hi");
    expect(JSON.stringify(await store.get("chat-1"))).not.toContain("123456");
  });

  it("a mention with punctuation is stripped cleanly", async () => {
    const { handle, runTurn } = setup({ env: { FLAGS_ON: "chat.groups" } });
    await handle(dm("@agent, dinner?", { isGroup: true }));
    await handle(dm("hey @agent  what's on", { isGroup: true }));
    await handle(dm("(@agent) hi", { isGroup: true }));
    expect(runTurn.mock.calls.map((c) => c[0].text)).toEqual([
      "dinner?",
      "hey what's on",
      "( ) hi",
    ]);
  });

  it("a code after a group mention is still caught", async () => {
    const { handle, verifyCode, runTurn } = setup({ env: { FLAGS_ON: "chat.groups" } });
    await handle(dm("@agent, CODE 123456", { isGroup: true, senderAddress: "+19175550142" }));
    expect(verifyCode).toHaveBeenCalledWith("+19175550142", "123456");
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("keeps chats' memory separate", async () => {
    const { handle, runTurn } = setup();
    await handle(dm("hi", { location: pin }));
    await handle(dm("hi", { spaceId: "chat-2" }));
    expect(runTurn.mock.calls[1]?.[0]).toMatchObject({ lastLocation: null, recent: [] });
  });
});

describe("mentionPattern", () => {
  const mention = mentionPattern("agent");
  it.each([
    ["@agent hi", true],
    ["hey @Agent", true],
    ["hi\n@agent", true],
    ["@agent.", true],
    ["@agents hi", false],
    ["@agent_bot hi", false],
    ["mail x@agent.com", false],
    ["@agent.com", false],
  ])("%s → %s", (text, expected) => {
    expect(mention.test(text)).toBe(expected);
  });
});

describe("extractCode", () => {
  it.each([
    ["CODE 123456", "123456", ""],
    ["code: 123 456", "123456", ""],
    ["Code #123456.", "123456", ""],
    ["hi\nCODE 123456\nthanks", "123456", "hi\nthanks"],
    ["my code is 123456", null, "my code is 123456"],
    ["CODE 12345", null, "CODE 12345"],
  ])("%j", (text, code, rest) => {
    expect(extractCode(text)).toEqual({ code, rest });
  });
});
