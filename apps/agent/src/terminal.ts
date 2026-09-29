import { createInterface } from "node:readline";
import { type Location, parseCoordinates } from "@aroundus/core";
import type { ChannelAdapter, InboundMessage } from "./channel.ts";

export const TERMINAL_SPACE = "terminal";

/**
 * A pasted "40.8,-73.96" or Maps link counts as a shared location; anything
 * else is text. Returns null for a blank line.
 */
export function parseTerminalLine(line: string): { text: string; location?: Location } | null {
  const text = line.trim();
  if (!text) return null;
  const coords = parseCoordinates(text);
  if (coords) return { text: "", location: { label: "shared location", ...coords } };
  return { text };
}

type Command =
  | { kind: "group"; on: boolean }
  | { kind: "sender"; sender: string | undefined }
  | { kind: "usage"; message: string };

const USAGE = "· commands: /group on|off, /sender <phone or email> (blank clears it)";

/** "/group on", "/sender +1917…". Null if the line isn't a command. */
export function parseCommand(line: string): Command | null {
  const match = /^\/(\w+)(?:\s+(.*))?$/.exec(line.trim());
  if (!match) return null;
  const [, name, arg = ""] = match;
  if (name === "group") {
    const value = arg.trim().toLowerCase();
    if (value === "on" || value === "off") return { kind: "group", on: value === "on" };
    return { kind: "usage", message: USAGE };
  }
  if (name === "sender") return { kind: "sender", sender: arg.trim() || undefined };
  return { kind: "usage", message: USAGE };
}

/**
 * The dev loop: stdin in, stdout out. `/group on|off` and `/sender <address>`
 * let you exercise group-chat and beta-flag paths without a phone.
 */
export function createTerminalAdapter(
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = {
    input: process.stdin,
    output: process.stdout,
  },
): ChannelAdapter {
  let rl: ReturnType<typeof createInterface> | undefined;
  let isGroup = false;
  let senderAddress: string | undefined;
  const print = (line: string) => io.output.write(`${line}\n`);

  return {
    async start(onMessage) {
      rl = createInterface({ input: io.input, terminal: false });
      rl.on("line", (line) => {
        const command = parseCommand(line);
        if (command) {
          if (command.kind === "group") isGroup = command.on;
          else if (command.kind === "sender") senderAddress = command.sender;
          else print(command.message);
          print(`· group=${isGroup ? "on" : "off"} sender=${senderAddress ?? "none"}`);
          return;
        }
        const parsed = parseTerminalLine(line);
        if (!parsed) return;
        const message: InboundMessage = { spaceId: TERMINAL_SPACE, isGroup, ...parsed };
        if (senderAddress) message.senderAddress = senderAddress;
        onMessage(message);
      });
    },
    async send(_spaceId, text) {
      print(`agent> ${text}`);
    },
    async sendTo(phone, text) {
      print(`agent → ${phone}> ${text}`);
    },
    async stop() {
      rl?.close();
    },
  };
}
