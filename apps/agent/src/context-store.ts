import { createHash } from "node:crypto";
import { type ChatLine, Location, type Query } from "@aroundus/core";
import { z } from "zod";

export const RECENT_LINES = 6;

export type ChatContext = { lastLocation: Location | null; recent: ChatLine[] };

/** Per-chat memory. Never stores phone numbers: chats are keyed by a hash. */
export interface ContextStore {
  get(spaceId: string): Promise<ChatContext>;
  setLocation(spaceId: string, location: Location): Promise<void>;
  /** Appends lines and keeps only the last RECENT_LINES. */
  appendLines(spaceId: string, lines: ChatLine[]): Promise<void>;
}

/** sha256 of the chat id. iMessage chat ids can contain phone numbers. */
export function chatKey(spaceId: string): string {
  return createHash("sha256").update(spaceId).digest("hex");
}

const keepRecent = (lines: ChatLine[]) => lines.slice(-RECENT_LINES);

export function createMemoryContextStore(): ContextStore {
  const chats = new Map<string, ChatContext>();
  const read = (spaceId: string) =>
    chats.get(chatKey(spaceId)) ?? { lastLocation: null, recent: [] };

  return {
    async get(spaceId) {
      const c = read(spaceId);
      return { lastLocation: c.lastLocation, recent: [...c.recent] };
    },
    async setLocation(spaceId, location) {
      chats.set(chatKey(spaceId), { ...read(spaceId), lastLocation: location });
    },
    async appendLines(spaceId, lines) {
      const c = read(spaceId);
      chats.set(chatKey(spaceId), { ...c, recent: keepRecent([...c.recent, ...lines]) });
    },
  };
}

const StoredLines = z.array(z.object({ role: z.enum(["user", "agent"]), text: z.string() }));

/**
 * Postgres-backed store over app.chat_context (sql/001_chat_context.sql).
 * appendLines reads then writes; the inbox runs one turn per chat at a time,
 * so there's no concurrent writer for the same chat.
 */
export function createPgContextStore(query: Query): ContextStore {
  const read = async (key: string): Promise<ChatContext> => {
    const rows = await query<{ last_location: unknown; recent: unknown }>(
      "select last_location, recent from app.chat_context where chat_key = $1",
      [key],
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
    get: (spaceId) => read(chatKey(spaceId)),
    async setLocation(spaceId, location) {
      await query(
        `insert into app.chat_context (chat_key, last_location) values ($1, $2::jsonb)
         on conflict (chat_key) do update set last_location = excluded.last_location, updated_at = now()`,
        [chatKey(spaceId), JSON.stringify(location)],
      );
    },
    async appendLines(spaceId, lines) {
      const key = chatKey(spaceId);
      const { recent } = await read(key);
      await query(
        `insert into app.chat_context (chat_key, recent) values ($1, $2::jsonb)
         on conflict (chat_key) do update set recent = excluded.recent, updated_at = now()`,
        [key, JSON.stringify(keepRecent([...recent, ...lines]))],
      );
    },
  };
}
