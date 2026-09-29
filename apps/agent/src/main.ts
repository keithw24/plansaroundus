import {
  ConfigError,
  createFlags,
  createLlm,
  createLogger,
  describeMissing,
  geminiGenerate,
  loadConfig,
} from "@aroundus/core";
import { createAgent } from "./agent.ts";
import type { ChannelAdapter } from "./channel.ts";
import {
  type ContextStore,
  createMemoryContextStore,
  createPgContextStore,
} from "./context-store.ts";
import { createPgQuery } from "./pg.ts";
import { createIntentPreviewTurn } from "./replies.ts";
import { createTerminalAdapter } from "./terminal.ts";

// Docker gives 10 s between SIGTERM and SIGKILL; leave room to close the database.
const SHUTDOWN_DEADLINE_MS = 8_000;

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
const llm = config.gemini ? createLlm(geminiGenerate(config.gemini)) : null;

let store: ContextStore;
let closeDb = async () => {};
if (config.databaseUrl && config.chatKeySecret) {
  const db = createPgQuery(config.databaseUrl, log);
  store = createPgContextStore(db.query, config.chatKeySecret);
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

const agent = createAgent({
  channel,
  store,
  flags,
  runTurn: createIntentPreviewTurn(llm),
  log,
  inboxBatchMs: config.inboxBatchMs,
});

let stopping = false;
async function shutdown(reason: string) {
  if (stopping) {
    log.warn("second signal: exiting now");
    process.exit(1);
  }
  stopping = true;
  log.info("shutting down", { reason });
  const drained = await agent.shutdown(SHUTDOWN_DEADLINE_MS);
  await closeDb().catch((err: unknown) => log.warn("could not close database", { err }));
  process.exit(drained ? 0 : 1);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
// In the terminal, closing stdin (Ctrl-D or end of a pipe) answers what's pending, then exits.
if (config.chat.provider === "terminal")
  process.stdin.on("end", () => void shutdown("stdin closed"));

await agent.start();
log.info("agent started", { chat: config.chat.provider, flags: flags.effective() });
