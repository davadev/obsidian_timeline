/**
 * Level-gated console logging.
 *
 * Obsidian's plugin guidelines ask plugins not to log to the console during
 * normal operation, so everything here is off unless the user raises
 * `logLevel` in settings. `error` still goes out at the default level — a
 * crash the user has to report is worth a console line.
 */
export type LogLevel = "error" | "warn" | "info" | "debug";

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const PREFIX = "[Timeline XML Sync]";

let current: LogLevel = "error";

/** Called from the plugin's settings load/save path. */
export function setLogLevel(level: LogLevel): void {
  current = level;
}

function enabled(level: LogLevel): boolean {
  return RANK[level] <= RANK[current];
}

/**
 * Ungated output for commands whose whole purpose is to print something the
 * user asked for (the diagnostics dump). Uses console.debug so it stays out
 * of the default console view unless the user opens verbose logging.
 */
export function logDump(...args: unknown[]): void {
  console.debug(PREFIX, ...args);
}

/** Verbose operational detail — off unless logLevel is "debug". */
export function logDebug(...args: unknown[]): void {
  if (enabled("debug")) console.debug(PREFIX, ...args);
}

export function logWarn(...args: unknown[]): void {
  if (enabled("warn")) console.warn(PREFIX, ...args);
}

export function logError(...args: unknown[]): void {
  if (enabled("error")) console.error(PREFIX, ...args);
}
