import type { Location } from "@aroundus/core";

export type InboundMessage = {
  /** The chat: a DM or a group. Replies go back here. */
  spaceId: string;
  text: string;
  location?: Location;
  isGroup: boolean;
  /** Phone number or Apple ID email of whoever sent it, when known. */
  senderAddress?: string;
};

/** The only thing that sends messages. Skills and the router never do. */
export interface ChannelAdapter {
  /** Starts listening. Resolves once listening; messages then arrive via `onMessage`. */
  start(onMessage: (message: InboundMessage) => void): Promise<void>;
  send(spaceId: string, text: string): Promise<void>;
  /** A direct message to a number, outside any existing chat. */
  sendTo(phone: string, text: string): Promise<void>;
  stop(): Promise<void>;
}
