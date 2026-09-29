-- Per-chat memory: the last shared location and the last few lines.
-- Keyed by an HMAC of the chat id (CHAT_KEY_SECRET) so no phone number is ever stored.
create schema if not exists app;

create table if not exists app.chat_context (
  chat_key      text primary key,
  last_location jsonb,
  recent        jsonb not null default '[]'::jsonb,
  updated_at    timestamptz not null default now()
);
