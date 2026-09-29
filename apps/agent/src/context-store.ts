import { createHmac } from "node:crypto";
import { type ChatLine, Location, type Query } from "@aroundus/core";
import { z } from "zod";

export const RECENT_LINES = 6;

export type ChatContext = { lastLocation: Location | null; recent: ChatLine[] };

/** Per-chat memory. Never stores phone numbers: persisted chats are keyed by an HMAC. */
export interface ContextStore {
  get(spaceId: string): Promise<ChatContext>;
  setLocation(spaceId: string, location: Location): Promise<void>;
  /** Appends lines and keeps only the last RECENT_LINES. */
  appendLines(spaceId: string, lines: ChatLine[]): Promise<void>;
}

/**
 * HMAC-SHA256 of the chat id. iMessage chat ids can contain phone numbers, and
 * a plain hash of a US number is easy to brute-force; without the secret it isn't.
 */
export function chatKey(secret: string, spaceId: string): string {
  return createHmac("sha256", secret).update(spaceId).digest("hex");
}

const keepRecent = (lines: ChatLine[]) => lines.slice(-RECENT_LINES);

/** In-process only (tests, keyless dev), so chat ids are never written anywhere. */
export function createMemoryContextStore(): ContextStore {
  const chats = new Map<string, ChatContext>();
  const read = (spaceId: string) => chats.get(spaceId) ?? { lastLocation: null, recent: [] };

  return {
    async get(spaceId) {
      const c = read(spaceId);
      return { lastLocation: c.lastLocation, recent: [...c.recent] };
    },
    async setLocation(spaceId, location) {
      chats.set(spaceId, { ...read(spaceId), lastLocation: location });
    },
    async appendLines(spaceId, lines) {
      const c = read(spaceId);
      chats.set(spaceId, { ...c, recent: keepRecent([...c.recent, ...lines]) });
    },
  };
}

const StoredLines = z.array(z.object({ role: z.enum(["user", "agent"]), text: z.string() }));

/**
 * Postgres-backed store over app.chat_context (sql/001_chat_context.sql).
 * appendLines reads then writes; the inbox runs one turn per chat at a time,
 * so there's no concurrent writer for the same chat.
 */
export function createPgContextStore(query: Query, keySecret: string): ContextStore {
  const key = (spaceId: string) => chatKey(keySecret, spaceId);
  const read = async (chat: string): Promise<ChatContext> => {
    const rows = await query<{ last_location: unknown; recent: unknown }>(
      "select last_location, recent from app.chat_context where chat_key = $1",
      [chat],
    );
    const row = rows[0];
    if (!row) return { lastLocation: null, recent: [] };
    // Anything malformed is dropped rather than failing the turn.
    const location = Location.safeParse(row.last_location);
    const recent = StoredLines.safeParse(row.recent);
    return {
      lastLocation: location.success ? location.data : null,
      recent: recent.success ? keepRecent(recent.data) : [],
    };
  };

  return {
    get: (spaceId) => read(key(spaceId)),
    async setLocation(spaceId, location) {
      await query(
        `insert into app.chat_context (chat_key, last_location) values ($1, $2::jsonb)
         on conflict (chat_key) do update set last_location = excluded.last_location, updated_at = now()`,
        [key(spaceId), JSON.stringify(location)],
      );
    },
    async appendLines(spaceId, lines) {
      const chat = key(spaceId);
      const { recent } = await read(chat);
      await query(
        `insert into app.chat_context (chat_key, recent) values ($1, $2::jsonb)
         on conflict (chat_key) do update set recent = excluded.recent, updated_at = now()`,
        [chat, JSON.stringify(keepRecent([...recent, ...lines]))],
      );
    },
  };
}
