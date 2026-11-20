const REDACTED_KEYS = /phone|email|token|authorization|secret|password|cookie/i;

type Fields = Record<string, unknown>;
type Level = "debug" | "info" | "warn" | "error";
type Write = (line: string) => void;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  /** A logger that adds the request id to every line. */
  withRequestId(requestId: string): Logger;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (value instanceof Error)
    return { name: value.name, message: value.message, stack: value.stack };
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      REDACTED_KEYS.test(key) ? "[redacted]" : redact(item, depth + 1),
    ]),
  );
}

export function createLogger(
  options: { service: string; write?: Write },
  bound: Fields = {},
): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emit = (level: Level, msg: string, fields: Fields = {}) => {
    const line = {
      time: new Date().toISOString(),
      level,
      service: options.service,
      msg,
      ...bound,
      ...fields,
    };
    write(JSON.stringify(redact(line)));
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    withRequestId: (requestId) => createLogger(options, { ...bound, requestId }),
  };
}
