import type { Flags, Logger, TurnRunner } from "@aroundus/core";
import type { ChannelAdapter } from "./channel.ts";
import type { ContextStore } from "./context-store.ts";
import { createInbox } from "./inbox.ts";
import { type CodeVerifier, createTurnHandler } from "./turn-handler.ts";

/**
 * The agent without any process wiring: channel in, turns, channel out.
 * main.ts builds the dependencies; later phases add the HTTP API alongside.
 */
export function createAgent(deps: {
  channel: ChannelAdapter;
  store: ContextStore;
  flags: Flags;
  runTurn: TurnRunner;
  log: Logger;
  inboxBatchMs: number;
  verifyCode?: CodeVerifier;
}) {
  const { channel, log } = deps;
  const handle = createTurnHandler(deps);
  const inbox = createInbox({ delayMs: deps.inboxBatchMs, onBatch: handle, log });

  return {
    start: () => channel.start((message) => inbox.push(message)),

    /**
     * Stops taking messages, answers what's pending (up to `deadlineMs`), then
     * stops the channel. Replies go out before the channel closes.
     * Returns false if turns were still running at the deadline.
     */
    async shutdown(deadlineMs: number): Promise<boolean> {
      inbox.close();
      let timer: NodeJS.Timeout | undefined;
      const drained = await Promise.race([
        inbox.drain().then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), deadlineMs);
        }),
      ]);
      clearTimeout(timer);
      if (!drained) log.warn("shutdown deadline hit with turns still running");
      await channel.stop();
      return drained;
    },
  };
}
