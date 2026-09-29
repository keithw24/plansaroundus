import type { Logger } from "@aroundus/core";
import type { InboundMessage } from "./channel.ts";

/**
 * Batches messages per chat, because people send "dinner" then "near columbia".
 * A batch is answered `delayMs` after its last message, or `maxWaitMs` after its
 * first, whichever is sooner. Batches for one chat are handled one at a time,
 * in order; different chats run independently.
 */
export function createInbox(opts: {
  delayMs: number;
  maxWaitMs?: number;
  onBatch: (message: InboundMessage) => Promise<void>;
  log: Logger;
}) {
  const maxWaitMs = opts.maxWaitMs ?? opts.delayMs * 3;
  type Pending = { messages: InboundMessage[]; timer: NodeJS.Timeout; firstAt: number };
  const pending = new Map<string, Pending>();
  const running = new Map<string, Promise<void>>();

  const flush = (spaceId: string) => {
    const batch = pending.get(spaceId);
    if (!batch) return;
    clearTimeout(batch.timer);
    pending.delete(spaceId);
    const message = merge(batch.messages);

    const previous = running.get(spaceId) ?? Promise.resolve();
    const next = previous
      .then(() => opts.onBatch(message))
      .catch((err: unknown) => opts.log.error("batch failed", { err }))
      .finally(() => {
        if (running.get(spaceId) === next) running.delete(spaceId);
      });
    running.set(spaceId, next);
  };

  return {
    push(message: InboundMessage) {
      const now = Date.now();
      const existing = pending.get(message.spaceId);
      if (existing) clearTimeout(existing.timer);
      const batch = existing ?? { messages: [], timer: undefined as never, firstAt: now };
      batch.messages.push(message);
      const wait = Math.max(0, Math.min(opts.delayMs, batch.firstAt + maxWaitMs - now));
      batch.timer = setTimeout(() => flush(message.spaceId), wait);
      pending.set(message.spaceId, batch);
    },
    /** Answers everything pending now and waits for all turns to finish. */
    async drain() {
      for (const spaceId of [...pending.keys()]) flush(spaceId);
      await Promise.all(running.values());
    },
  };
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
