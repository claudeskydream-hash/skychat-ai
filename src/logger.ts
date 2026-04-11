const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

let currentLevel: Level = "info";

export function setLogLevel(level: Level) {
  currentLevel = level;
}

function fmt(level: Level, scope: string, msg: string): string {
  const ts = new Date().toISOString().slice(11, 23);
  const tag = level.toUpperCase().padEnd(5);
  return `\x1b[90m${ts}\x1b[0m ${colorize(level, tag)} \x1b[36m[${scope}]\x1b[0m ${msg}`;
}

function colorize(level: Level, text: string): string {
  switch (level) {
    case "debug": return `\x1b[90m${text}\x1b[0m`;
    case "info":  return `\x1b[32m${text}\x1b[0m`;
    case "warn":  return `\x1b[33m${text}\x1b[0m`;
    case "error": return `\x1b[31m${text}\x1b[0m`;
  }
}

export function createLogger(scope: string) {
  return {
    debug: (msg: string) => { if (LEVELS[currentLevel] <= 0) console.log(fmt("debug", scope, msg)); },
    info:  (msg: string) => { if (LEVELS[currentLevel] <= 1) console.log(fmt("info",  scope, msg)); },
    warn:  (msg: string) => { if (LEVELS[currentLevel] <= 2) console.warn(fmt("warn",  scope, msg)); },
    error: (msg: string) => { if (LEVELS[currentLevel] <= 3) console.error(fmt("error", scope, msg)); },
  };
}
