import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../src/channel.ts";
import { createTerminalAdapter, parseCommand, parseTerminalLine } from "../src/terminal.ts";

describe("parseTerminalLine", () => {
  it("treats pasted coordinates and Maps links as a shared location", () => {
    expect(parseTerminalLine("40.8,-73.96")).toEqual({
      text: "",
      location: { label: "shared location", latitude: 40.8, longitude: -73.96 },
    });
    expect(parseTerminalLine("https://maps.google.com/?q=40.7,-73.9")?.location).toMatchObject({
      latitude: 40.7,
    });
  });

  it("doesn't mistake plain numbers for a location", () => {
    expect(parseTerminalLine("2,3")).toEqual({ text: "2,3" });
    expect(parseTerminalLine("10,000")).toEqual({ text: "10,000" });
  });

  it("treats anything else as text and skips blank lines", () => {
    expect(parseTerminalLine("  hi ")).toEqual({ text: "hi" });
    expect(parseTerminalLine("   ")).toBeNull();
  });
});

describe("terminal adapter", () => {
  it("reads lines, applies /group and /sender, and prints replies", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = "";
    output.on("data", (chunk: Buffer) => {
      printed += chunk.toString();
    });
    const adapter = createTerminalAdapter({ input, output });
    const received: InboundMessage[] = [];
    await adapter.start((m) => received.push(m));

    input.write("hi\n/group on\n/sender +19175550142\n@agent hello\n");
    await new Promise((r) => setImmediate(r));
    await adapter.send("terminal", "hey");
    await adapter.stop();

    expect(received).toEqual([
      { spaceId: "terminal", text: "hi", isGroup: false },
      { spaceId: "terminal", text: "@agent hello", isGroup: true, senderAddress: "+19175550142" },
    ]);
    expect(printed).toContain("· group=on sender=+19175550142");
    expect(printed).toContain("agent> hey\n");
  });
});

describe("parseCommand", () => {
  it.each([
    ["/group on", { kind: "group", on: true }],
    ["/group OFF", { kind: "group", on: false }],
    ["/sender +19175550142", { kind: "sender", sender: "+19175550142" }],
    ["/sender", { kind: "sender", sender: undefined }],
  ])("%s", (line, expected) => {
    expect(parseCommand(line)).toEqual(expected);
  });

  it("shows usage for bad or unknown commands instead of guessing", () => {
    expect(parseCommand("/group yes")?.kind).toBe("usage");
    expect(parseCommand("/groupies")?.kind).toBe("usage");
    expect(parseCommand("hi /group on")).toBeNull();
  });
});
