import type { ChannelAdapter, InboundMessage } from "../src/channel.ts";

export function fakeChannel() {
  const sent: { spaceId: string; text: string }[] = [];
  let onMessage: ((m: InboundMessage) => void) | undefined;
  const channel: ChannelAdapter & { failSends: boolean } = {
    failSends: false,
    async start(cb) {
      onMessage = cb;
    },
    async send(spaceId, text) {
      if (channel.failSends) throw new Error("send failed");
      sent.push({ spaceId, text });
    },
    async sendTo(phone, text) {
      sent.push({ spaceId: `to:${phone}`, text });
    },
    async stop() {},
  };
  return { channel, sent, deliver: (m: InboundMessage) => onMessage?.(m) };
}

export const pin = { label: "shared location", latitude: 40.8075, longitude: -73.9626 };

export const dm = (text: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({
  spaceId: "chat-1",
  text,
  isGroup: false,
  ...extra,
});
