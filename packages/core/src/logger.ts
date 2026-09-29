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
    const time = new Date().toISOString();
    let line: string;
    try {
      // time/level/msg go last so fields can't overwrite them.
      line = JSON.stringify(toJsonSafe({ ...base, ...fields, time, level, msg }, []));
    } catch (err) {
      // A log call must never throw (e.g. a throwing getter in fields).
      line = JSON.stringify({ time, level, msg, logError: String(err) });
    }
    write(line);
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

/**
 * A JSON-safe copy: BigInts become strings, Errors keep name, message, stack,
 * own fields (LlmError.kind, ConfigError.issues) and their cause chain.
 * Only true cycles (an object inside itself) become "[circular]"; the same
 * object logged twice side by side is printed twice.
 */
function toJsonSafe(value: unknown, ancestors: object[]): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (ancestors.includes(value)) return "[circular]";
  if (ancestors.length > 20) return "[too deep]";
  const path = [...ancestors, value];

  if (value instanceof Error) {
    const out: LogFields = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v, path);
    out.name = value.name;
    out.message = value.message;
    out.stack = value.stack;
    if (value.cause !== undefined) out.cause = toJsonSafe(value.cause, path);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => toJsonSafe(v, path));
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return value; // Date, URL…
  const out: LogFields = {};
  for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v, path);
  return out;
}
