// The logging the app depends on, which pino's logger satisfies without wrapping: JSON lines to
// stdout, or to the given destination.

import { type DestinationStream, pino } from "pino";

export type LogFn = (fields: object, message: string) => void;

export interface Logger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

export function createLogger(destination?: DestinationStream): Logger {
  return pino({ name: "mage" }, destination);
}

// Human-readable log lines for development; its library is only installed there.
export async function createPrettyDestination(): Promise<DestinationStream> {
  const { default: pretty } = await import("pino-pretty").catch(() => {
    throw new Error("LOG_FORMAT=pretty needs the development dependencies installed");
  });
  return pretty({ sync: true });
}
