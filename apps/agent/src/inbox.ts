import type { Logger } from "@aroundus/core";
import type { InboundMessage } from "./channel.ts";

/**
 * Batches messages because people send "dinner" then "near columbia".
 *
 * - A batch is answered `delayMs` after its last message, or `maxWaitMs` after
 *   its first, whichever is sooner. A pin with no text yet waits the full
 *   `maxWaitMs` for the question that usually follows it.
 * - In group chats each sender gets their own batch, so one person's words
 *   (and flags, and sign-in code) are never attributed to another.
 * - One chat answers one batch at a time, in order. Messages that arrive while
 *   a turn is running wait and go into the next batch.
 */
export function createInbox(opts: {
  delayMs: number;
  maxWaitMs?: number;
  onBatch: (message: InboundMessage) => Promise<void>;
  log: Logger;
}) {
  const maxWaitMs = opts.maxWaitMs ?? opts.delayMs * 3;
  type Batch = {
    spaceId: string;
    messages: InboundMessage[];
    firstAt: number;
    timer: NodeJS.Timeout | undefined;
    /** Its wait is over; it runs as soon as the chat is free. */
    due: boolean;
  };
  const pending = new Map<string, Batch>();
  const running = new Map<string, Promise<void>>();
  let closed = false;

  const start = (key: string, batch: Batch) => {
    pending.delete(key);
    const message = merge(batch.messages);
    const run = opts
      .onBatch(message)
      .catch((err: unknown) => opts.log.error("batch failed", { err }))
      .finally(() => {
        running.delete(batch.spaceId);
        startNextDue(batch.spaceId);
      });
    running.set(batch.spaceId, run);
  };

  const startNextDue = (spaceId: string) => {
    if (running.has(spaceId)) return;
    for (const [key, batch] of pending) {
      if (batch.spaceId === spaceId && batch.due) return start(key, batch);
    }
  };

  const markDue = (key: string) => {
    const batch = pending.get(key);
    if (!batch) return;
    clearTimeout(batch.timer);
    batch.due = true;
    startNextDue(batch.spaceId);
  };

  return {
    push(message: InboundMessage) {
      if (closed) return;
      const key = batchKey(message);
      const now = Date.now();
      let batch = pending.get(key);
      if (!batch) {
        batch = {
          spaceId: message.spaceId,
          messages: [],
          firstAt: now,
          timer: undefined,
          due: false,
        };
        pending.set(key, batch);
      }
      batch.messages.push(message);
      // A due batch is only waiting for its chat to be free; it just grows.
      if (batch.due) return;

      clearTimeout(batch.timer);
      const hasText = batch.messages.some((m) => m.text.trim());
      const untilMax = batch.firstAt + maxWaitMs - now;
      const wait = Math.max(0, hasText ? Math.min(opts.delayMs, untilMax) : untilMax);
      batch.timer = setTimeout(() => markDue(key), wait);
    },

    /** Stops taking messages. Pending batches still run on drain(). */
    close() {
      closed = true;
    },

    /** Answers everything pending now and waits until every chat is idle. */
    async drain() {
      while (pending.size > 0 || running.size > 0) {
        for (const key of [...pending.keys()]) markDue(key);
        await Promise.all(running.values());
      }
    },
  };
}

function batchKey(message: InboundMessage): string {
  return message.isGroup
    ? `${message.spaceId}\u0000${message.senderAddress ?? ""}`
    : message.spaceId;
}

/** Texts joined by newlines; the latest location and sender win. */
export function merge(messages: InboundMessage[]): InboundMessage {
  const last = messages.at(-1);
  if (!last) throw new Error("empty batch");
  const merged: InboundMessage = {
    spaceId: last.spaceId,
    isGroup: last.isGroup,
    text: messages
      .map((m) => m.text.trim())
      .filter(Boolean)
      .join("\n"),
  };
  const location = messages.findLast((m) => m.location)?.location;
  if (location) merged.location = location;
  const sender = messages.findLast((m) => m.senderAddress)?.senderAddress;
  if (sender) merged.senderAddress = sender;
  return merged;
}
