const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const MAX_ENTRIES = 500;

function configuredLevel() {
  const value = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return LEVELS[value] ?? LEVELS.info;
}

let threshold = configuredLevel();

// In-memory ring buffer so the web dashboard can show what the bot has been
// doing. Nothing is written to disk.
const entries = [];
let sequence = 0;
const listeners = new Set();

function describe(meta) {
  if (meta instanceof Error) return meta.stack ?? `${meta.name}: ${meta.message}`;
  if (typeof meta === 'string') return meta;

  try {
    const text = JSON.stringify(meta);
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return String(meta);
  }
}

function record(level, message, meta) {
  const entry = {
    seq: ++sequence,
    time: new Date().toISOString(),
    level,
    message: meta === undefined ? message : `${message} ${describe(meta)}`,
  };

  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);

  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {
      // A broken log consumer must never break logging.
    }
  }
}

function write(level, message, meta) {
  if (LEVELS[level] > threshold) return;

  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  const stream = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

  if (meta === undefined) stream(line);
  else stream(line, meta);
}

export const logger = {
  error: (message, meta) => {
    record('error', message, meta);
    write('error', message, meta);
  },
  warn: (message, meta) => {
    record('warn', message, meta);
    write('warn', message, meta);
  },
  info: (message, meta) => {
    record('info', message, meta);
    write('info', message, meta);
  },
  debug: (message, meta) => {
    record('debug', message, meta);
    write('debug', message, meta);
  },
};

/** Returns recent log entries, oldest first. `since` is an exclusive sequence number. */
export function getRecentLogs({ since = 0, limit = 200 } = {}) {
  const filtered = entries.filter((entry) => entry.seq > since);
  return filtered.slice(-Math.max(1, Math.min(limit, MAX_ENTRIES)));
}

/** Subscribes to new log entries. Returns an unsubscribe function. */
export function subscribeLogs(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Allows tests/tools to change verbosity after an env change. */
export function setLogLevel(level) {
  threshold = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
  return threshold;
}
