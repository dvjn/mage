// The logging the app depends on; pino's logger satisfies it without wrapping.

export type LogFn = (fields: object, message: string) => void;

export interface Logger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}
