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
    write(
      JSON.stringify(
        { time: new Date().toISOString(), level, msg, ...base, ...fields },
        errorReplacer,
      ),
    );
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

// Errors stringify to {} by default; keep the useful parts.
function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error)
    return { name: value.name, message: value.message, stack: value.stack };
  return value;
}
