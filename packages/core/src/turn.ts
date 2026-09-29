import type { Location } from "./contracts.ts";
import type { SenderFlags } from "./flags.ts";
import type { Logger } from "./logger.ts";

/** One remembered line of a chat. */
export type ChatLine = { role: "user" | "agent"; text: string };

/** Everything the router needs to answer one batched message. */
export type TurnInput = {
  text: string;
  now: Date;
  /** The last pin shared in this chat, if any. */
  lastLocation: Location | null;
  /** The last few lines, oldest first, not including `text`. */
  recent: ChatLine[];
  /** Flags already resolved for this sender. */
  flags: SenderFlags;
  signal: AbortSignal;
  log: Logger;
};

/** Answers one turn with the reply text. Only the chat adapter sends it. */
export type TurnRunner = (input: TurnInput) => Promise<string>;
