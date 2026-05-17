import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

let currentLevel: Level = "info";

// ── File logger state ────────────────────────────────────────────────────────
let _logDir: string | null = null;
let _logFilePath: string | null = null;
let _logFileDate: string | null = null;

/**
 * Enable file logging. Creates the directory if it does not exist.
 * Must be called before any loggers are used for file output to take effect.
 */
export function initFileLogger(dir: string): void {
  _logDir = dir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function getLogFile(): string | null {
  if (!_logDir) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _logFileDate) {
    _logFileDate = today;
    _logFilePath = join(_logDir, `skychat-${today}.log`);
  }
  return _logFilePath;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function appendToFile(line: string): void {
  const file = getLogFile();
  if (!file) return;
  try {
    appendFileSync(file, stripAnsi(line) + "\n", "utf-8");
  } catch {
    // Never let file I/O errors crash the application
  }
}

// ── Formatters ───────────────────────────────────────────────────────────────

export function setLogLevel(level: Level) {
  currentLevel = level;
}

function fmt(level: Level, scope: string, msg: string): string {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 23);
  const tag = level.toUpperCase().padEnd(5);
  return `\x1b[90m${ts}\x1b[0m ${colorize(level, tag)} \x1b[36m[${scope}]\x1b[0m ${msg}`;
}

function fmtPlain(level: Level, scope: string, msg: string): string {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 23);
  const tag = level.toUpperCase().padEnd(5);
  return `${ts} ${tag} [${scope}] ${msg}`;
}

function colorize(level: Level, text: string): string {
  switch (level) {
    case "debug": return `\x1b[90m${text}\x1b[0m`;
    case "info":  return `\x1b[32m${text}\x1b[0m`;
    case "warn":  return `\x1b[33m${text}\x1b[0m`;
    case "error": return `\x1b[31m${text}\x1b[0m`;
  }
}

// ── Logger factory ───────────────────────────────────────────────────────────

export function createLogger(scope: string) {
  return {
    debug: (msg: string) => {
      if (LEVELS[currentLevel] <= 0) console.log(fmt("debug", scope, msg));
      appendToFile(fmtPlain("debug", scope, msg));
    },
    info: (msg: string) => {
      if (LEVELS[currentLevel] <= 1) console.log(fmt("info", scope, msg));
      appendToFile(fmtPlain("info", scope, msg));
    },
    warn: (msg: string) => {
      if (LEVELS[currentLevel] <= 2) console.warn(fmt("warn", scope, msg));
      appendToFile(fmtPlain("warn", scope, msg));
    },
    error: (msg: string) => {
      if (LEVELS[currentLevel] <= 3) console.error(fmt("error", scope, msg));
      appendToFile(fmtPlain("error", scope, msg));
    },
  };
}
