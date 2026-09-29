import {
  ConfigError,
  createFlags,
  createLogger,
  describeMissing,
  loadConfig,
} from "@aroundus/core";
import type { ChannelAdapter } from "./channel.ts";
import {
  type ContextStore,
  createMemoryContextStore,
  createPgContextStore,
} from "./context-store.ts";
import { createInbox } from "./inbox.ts";
import { createPgQuery } from "./pg.ts";
import { cannedTurn } from "./replies.ts";
import { createTerminalAdapter } from "./terminal.ts";
import { createTurnHandler } from "./turn-handler.ts";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const log = createLogger({ level: config.logLevel });
const missing = describeMissing(config);
if (missing) log.warn(missing);

const flags = createFlags(config.flags);

let store: ContextStore;
let closeDb = async () => {};
if (config.databaseUrl) {
  const db = createPgQuery(config.databaseUrl);
  store = createPgContextStore(db.query);
  closeDb = db.close;
} else {
  log.warn("no DATABASE_URL: chat memory is in-process and lost on restart");
  store = createMemoryContextStore();
}

let channel: ChannelAdapter;
if (config.chat.provider === "photon") {
  log.error("the Photon adapter isn't built yet (phase 6); use CHAT_PROVIDER=terminal");
  process.exit(1);
} else {
  channel = createTerminalAdapter();
}

const handle = createTurnHandler({ channel, store, flags, runTurn: cannedTurn, log });
const inbox = createInbox({ delayMs: config.inboxBatchMs, onBatch: handle, log });

let stopping = false;
async function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  log.info("shutting down", { reason });
  await channel.stop();
  await inbox.drain();
  await closeDb();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
// In the terminal, closing stdin (Ctrl-D or end of a pipe) answers what's pending, then exits.
if (config.chat.provider === "terminal")
  process.stdin.on("end", () => void shutdown("stdin closed"));

await channel.start((message) => inbox.push(message));
log.info("agent started", { chat: config.chat.provider, flags: flags.effective() });
