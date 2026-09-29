import type { ChatLine, Flags, Logger, TurnRunner } from "@aroundus/core";
import type { ChannelAdapter, InboundMessage } from "./channel.ts";
import type { ContextStore } from "./context-store.ts";
import { APOLOGY, SIGN_IN_UNAVAILABLE } from "./replies.ts";

/** Checks a website sign-in code texted to the agent. Returns the reply. Built in phase 8. */
export type CodeVerifier = (sender: string, code: string) => Promise<string>;

const CODE = /^code\s+(\d{6})$/i;

export function createTurnHandler(deps: {
  channel: ChannelAdapter;
  store: ContextStore;
  flags: Flags;
  runTurn: TurnRunner;
  log: Logger;
  verifyCode?: CodeVerifier;
  /** The handle people use in group chats, without the "@". */
  agentName?: string;
  turnTimeoutMs?: number;
  now?: () => Date;
}) {
  const { channel, store, flags, log } = deps;
  const mention = new RegExp(`(^|\\s)@${escapeRegExp(deps.agentName ?? "agent")}\\b`, "i");
  const turnTimeoutMs = deps.turnTimeoutMs ?? 25_000;
  const now = deps.now ?? (() => new Date());

  /** Handles one batched message. Never throws; any failure becomes an apology. */
  return async function handle(message: InboundMessage): Promise<void> {
    const { spaceId } = message;
    const sender = message.senderAddress ?? null;
    const turnLog = log.child({ turn: crypto.randomUUID(), group: message.isGroup });
    const started = Date.now();

    try {
      if (message.location) await store.setLocation(spaceId, message.location);

      let text = message.text.trim();
      if (message.isGroup) {
        if (!flags.enabled("chat.groups", { sender })) return;
        if (!mention.test(text)) return;
        text = text.replace(mention, " ").trim();
      }

      // Sign-in codes are answered here and never reach the router or chat memory.
      const code = CODE.exec(text)?.[1];
      if (code) {
        const reply =
          deps.verifyCode && sender ? await deps.verifyCode(sender, code) : SIGN_IN_UNAVAILABLE;
        await channel.send(spaceId, reply);
        turnLog.info("sign-in code handled", { ms: Date.now() - started });
        return;
      }

      const context = await store.get(spaceId);
      const reply = await withTimeout(turnTimeoutMs, (signal) =>
        deps.runTurn({
          text,
          now: now(),
          lastLocation: context.lastLocation,
          recent: context.recent,
          flags: flags.forSender(sender),
          signal,
          log: turnLog,
        }),
      );

      await channel.send(spaceId, reply);
      const lines: ChatLine[] = [];
      if (text) lines.push({ role: "user", text });
      lines.push({ role: "agent", text: reply });
      await store.appendLines(spaceId, lines).catch((err: unknown) => {
        turnLog.warn("could not save chat lines", { err });
      });
      turnLog.info("turn answered", { ms: Date.now() - started });
    } catch (err) {
      turnLog.error("turn failed", { err, ms: Date.now() - started });
      await channel.send(spaceId, APOLOGY).catch((sendErr: unknown) => {
        turnLog.error("could not send apology", { err: sendErr });
      });
    }
  };
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`turn took longer than ${ms} ms`);
      controller.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
