import { createFlags, parseFlagSettings, silentLogger } from "@aroundus/core";
import { describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.ts";
import { createMemoryContextStore } from "../src/context-store.ts";
import { dm, fakeChannel } from "./fakes.ts";

describe("agent shutdown", () => {
  it("answers pending messages before stopping the channel", async () => {
    const { channel, sent, deliver } = fakeChannel();
    const order: string[] = [];
    const send = channel.send.bind(channel);
    channel.send = async (space, text) => {
      order.push("send");
      await send(space, text);
    };
    channel.stop = async () => void order.push("stop");
    const agent = createAgent({
      channel,
      store: createMemoryContextStore(),
      flags: createFlags(parseFlagSettings({}).settings),
      runTurn: async () => "ok",
      log: silentLogger,
      inboxBatchMs: 60_000,
    });
    await agent.start();
    deliver(dm("hi"));
    expect(await agent.shutdown(1000)).toBe(true);
    expect(sent.map((s) => s.text)).toEqual(["ok"]);
    expect(order).toEqual(["send", "stop"]);
  });

  it("gives up on stuck turns at the deadline and still stops the channel", async () => {
    const { channel, deliver } = fakeChannel();
    let stopped = false;
    channel.stop = async () => {
      stopped = true;
    };
    const agent = createAgent({
      channel,
      store: createMemoryContextStore(),
      flags: createFlags(parseFlagSettings({}).settings),
      runTurn: () => new Promise(() => {}),
      log: silentLogger,
      inboxBatchMs: 0,
    });
    await agent.start();
    deliver(dm("hi"));
    expect(await agent.shutdown(30)).toBe(false);
    expect(stopped).toBe(true);
  });
});
