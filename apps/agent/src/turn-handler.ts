import type { ChatLine, Flags, Logger, TurnRunner } from "@aroundus/core";
import type { ChannelAdapter, InboundMessage } from "./channel.ts";
import type { ContextStore } from "./context-store.ts";
import { APOLOGY, SIGN_IN_UNAVAILABLE } from "./replies.ts";

/** Checks a website sign-in code texted to the agent. Returns the reply. Built in phase 8. */
export type CodeVerifier = (sender: string, code: string) => Promise<string>;

export type TurnHandlerDeps = {
  channel: ChannelAdapter;
  store: ContextStore;
  flags: Flags;
  runTurn: TurnRunner;
  log: Logger;
  verifyCode?: CodeVerifier;
  /** The handle people use in group chats, without the "@". */
  agentName?: string;
  /** Limit for reading context plus running the router. */
  turnTimeoutMs?: number;
  /** Limit for each store write and each send. */
  ioTimeoutMs?: number;
  now?: () => Date;
};

export function createTurnHandler(deps: TurnHandlerDeps) {
  const { channel, store, flags, log } = deps;
  const turnTimeoutMs = deps.turnTimeoutMs ?? 25_000;
  const ioTimeoutMs = deps.ioTimeoutMs ?? 10_000;
  const now = deps.now ?? (() => new Date());
  const mention = mentionPattern(deps.agentName ?? "agent");

  const send = (spaceId: string, text: string) =>
    withDeadline(ioTimeoutMs, "send", () => channel.send(spaceId, text));

  /**
   * Handles one batched message. Never throws. Every step has a time limit, so
   * one stuck call can't block the chat's later messages.
   */
  return async function handle(message: InboundMessage): Promise<void> {
    const { spaceId } = message;
    const sender = message.senderAddress ?? null;
    const turnLog = log.child({ turn: crypto.randomUUID(), group: message.isGroup });
    const started = Date.now();

    // Remember a shared pin even if we don't answer. Best effort: a failed
    // write must not cost the reply, or apologize to a group that didn't ask.
    if (message.location) {
      const location = message.location;
      await withDeadline(ioTimeoutMs, "save location", () =>
        store.setLocation(spaceId, location),
      ).catch((err: unknown) => turnLog.warn("could not save location", { err }));
    }

    let text = message.text.trim();
    if (message.isGroup) {
      if (!flags.enabled("chat.groups", { sender })) return;
      const stripped = stripMention(text, mention);
      if (stripped === null) return;
      text = stripped;
    }

    // From here on we're answering, so any failure gets an apology.
    try {
      // Sign-in codes are answered here and never reach the router or chat memory.
      const { code, rest } = extractCode(text);
      if (code) {
        const verify = deps.verifyCode;
        const reply =
          verify && sender
            ? await withDeadline(ioTimeoutMs, "verify code", () => verify(sender, code))
            : SIGN_IN_UNAVAILABLE;
        await send(spaceId, reply);
        turnLog.info("sign-in code handled", { ms: Date.now() - started });
        if (!rest) return;
        text = rest;
      }

      const reply = await withDeadline(turnTimeoutMs, "turn", async (signal) => {
        const stored = await store.get(spaceId);
        return deps.runTurn({
          text,
          now: now(),
          // The pin in this message wins, even if saving it failed.
          lastLocation: message.location ?? stored.lastLocation,
          recent: stored.recent,
          flags: flags.forSender(sender),
          signal,
          log: turnLog,
        });
      });

      await send(spaceId, reply);
      const lines: ChatLine[] = [];
      if (text) lines.push({ role: "user", text });
      lines.push({ role: "agent", text: reply });
      await withDeadline(ioTimeoutMs, "save lines", () => store.appendLines(spaceId, lines)).catch(
        (err: unknown) => turnLog.warn("could not save chat lines", { err }),
      );
      turnLog.info("turn answered", { ms: Date.now() - started });
    } catch (err) {
      turnLog.error("turn failed", { err, ms: Date.now() - started });
      await send(spaceId, APOLOGY).catch((sendErr: unknown) => {
        turnLog.error("could not send apology", { err: sendErr });
      });
    }
  };
}

/**
 * Matches "@agent" as a whole handle: not "@agents", "@agent_bot" or
 * "x@agent.com". Swallows punctuation right after it ("@agent, dinner?").
 */
export function mentionPattern(agentName: string): RegExp {
  const name = agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w@.])@${name}(?![\\w@-]|\\.\\w)[\\s,:;!?.]*`, "i");
}

/** The text without the mention, or null if the agent wasn't mentioned. */
export function stripMention(text: string, mention: RegExp): string | null {
  if (!mention.test(text)) return null;
  return text
    .replace(mention, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .trim();
}

// A whole line like "CODE 123456", "code: 123 456" or "Code #123456."
const CODE_LINE = /^code\b[\s:#-]*(\d{3})[\s-]?(\d{3})[.!]?$/i;

/**
 * Finds a sign-in code on any line, since batching can join it with other
 * messages. `rest` is the remaining lines, which still get a normal answer.
 */
export function extractCode(text: string): { code: string | null; rest: string } {
  const lines = text.split("\n").map((l) => l.trim());
  const index = lines.findIndex((l) => CODE_LINE.test(l));
  if (index === -1) return { code: null, rest: text };
  const match = CODE_LINE.exec(lines[index] ?? "");
  const rest = lines
    .filter((_, i) => i !== index)
    .filter(Boolean)
    .join("\n");
  return { code: `${match?.[1]}${match?.[2]}`, rest };
}

/** Runs `fn` with an abort signal; rejects if it takes longer than `ms`. */
async function withDeadline<T>(
  ms: number,
  what: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${what} took longer than ${ms} ms`);
      controller.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
