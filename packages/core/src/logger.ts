export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line, e.g. `{ skill: "food" }`. */
  child(fields: LogFields): Logger;
}

/** JSON-lines logger. Writes to stderr by default so stdout stays free for the terminal adapter. */
export function createLogger(
  opts: { level?: LogLevel; write?: (line: string) => void; base?: LogFields } = {},
): Logger {
  const min = LOG_LEVELS.indexOf(opts.level ?? "info");
  const write = opts.write ?? ((line) => process.stderr.write(`${line}\n`));
  const base = opts.base ?? {};

  const log = (level: LogLevel) => (msg: string, fields?: LogFields) => {
    if (LOG_LEVELS.indexOf(level) < min) return;
    // time/level/msg go last so fields can't overwrite them.
    write(safeStringify({ ...base, ...fields, time: new Date().toISOString(), level, msg }));
  };

  return {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    child: (fields) => createLogger({ ...opts, base: { ...base, ...fields } }),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

// A log call must never throw, so BigInts, cycles and Errors are handled here.
function safeStringify(entry: LogFields): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(entry, (_key, value: unknown) => {
      if (typeof value === "bigint") return value.toString();
      if (value instanceof Error) return serializeError(value);
      if (value !== null && typeof value === "object") {
        if (seen.has(value)) return "[seen]";
        seen.add(value);
      }
      return value;
    });
  } catch (err) {
    return JSON.stringify({
      time: entry.time,
      level: entry.level,
      msg: entry.msg,
      logError: String(err),
    });
  }
}

// Errors stringify to {} by default. Keep name/message/stack, own fields
// (LlmError.kind, ConfigError.issues) and the cause chain.
function serializeError(err: Error): LogFields {
  const out: LogFields = { ...err, name: err.name, message: err.message, stack: err.stack };
  if (err.cause !== undefined) out.cause = err.cause;
  return out;
}
