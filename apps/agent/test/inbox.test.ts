import { silentLogger } from "@aroundus/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "../src/channel.ts";
import { createInbox, merge } from "../src/inbox.ts";
import { dm, pin } from "./fakes.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(onBatch?: (m: InboundMessage) => Promise<void>) {
  const batches: InboundMessage[] = [];
  const inbox = createInbox({
    delayMs: 2000,
    log: silentLogger,
    onBatch: onBatch ?? (async (m) => void batches.push(m)),
  });
  return { inbox, batches };
}

describe("inbox", () => {
  it("batches messages sent close together", async () => {
    const { inbox, batches } = setup();
    inbox.push(dm("dinner"));
    await vi.advanceTimersByTimeAsync(1500);
    inbox.push(dm("near columbia"));
    await vi.advanceTimersByTimeAsync(1999);
    expect(batches).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches.map((b) => b.text)).toEqual(["dinner\nnear columbia"]);
  });

  it("answers after maxWait even if messages keep coming", async () => {
    const { inbox, batches } = setup();
    for (let i = 0; i < 6; i++) {
      inbox.push(dm(`m${i}`));
      await vi.advanceTimersByTimeAsync(1500);
    }
    expect(batches).toHaveLength(1);
    expect(batches[0]?.text).toBe("m0\nm1\nm2\nm3");
  });

  it("keeps chats separate", async () => {
    const { inbox, batches } = setup();
    inbox.push(dm("a", { spaceId: "one" }));
    inbox.push(dm("b", { spaceId: "two" }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(batches.map((b) => [b.spaceId, b.text])).toEqual([
      ["one", "a"],
      ["two", "b"],
    ]);
  });

  it("runs one chat's turns in order, one at a time", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const { inbox } = setup(async (m) => {
      order.push(`start ${m.text}`);
      if (m.text === "first") await new Promise<void>((r) => (release = r));
      order.push(`end ${m.text}`);
    });
    inbox.push(dm("first"));
    await vi.advanceTimersByTimeAsync(2000);
    inbox.push(dm("second"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(order).toEqual(["start first"]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["start first", "end first", "start second", "end second"]);
  });

  it("drain answers pending batches now", async () => {
    const { inbox, batches } = setup();
    inbox.push(dm("hi"));
    await inbox.drain();
    expect(batches).toHaveLength(1);
  });

  it("a failing batch doesn't block the next one", async () => {
    const seen: string[] = [];
    const { inbox } = setup(async (m) => {
      seen.push(m.text);
      if (m.text === "bad") throw new Error("boom");
    });
    inbox.push(dm("bad"));
    await vi.advanceTimersByTimeAsync(2000);
    inbox.push(dm("good"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toEqual(["bad", "good"]);
  });
});

describe("merge", () => {
  it("keeps the latest location and sender and skips blank text", () => {
    const merged = merge([
      dm("", { location: pin, senderAddress: "+19175550142" }),
      dm("dinner"),
      dm(" near columbia "),
    ]);
    expect(merged).toEqual({
      spaceId: "chat-1",
      isGroup: false,
      text: "dinner\nnear columbia",
      location: pin,
      senderAddress: "+19175550142",
    });
  });
});
