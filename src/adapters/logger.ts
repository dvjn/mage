// pino as the Logger port: JSON lines to stdout, or to the given destination.

import { type DestinationStream, pino } from "pino";

import type { Logger } from "@/ports/logger.ts";

export function createLogger(destination?: DestinationStream): Logger {
  return pino({ name: "mage" }, destination);
}
