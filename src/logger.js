'use strict';

const crypto = require('node:crypto');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function serializeError(err, withStack) {
  if (!(err instanceof Error)) return err;
  return {
    name: err.name,
    message: err.message,
    code: err.code,
    ...(withStack ? { stack: err.stack } : {}),
  };
}

/** Structured JSON-lines logger: info/debug to stdout, warn/error to stderr. */
function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = (lvl, msg, fields = {}) => {
    if (LEVELS[lvl] < threshold) return;
    const entry = { time: new Date().toISOString(), level: lvl, msg, ...fields };
    if ('err' in entry) entry.err = serializeError(entry.err, LEVELS[lvl] >= LEVELS.error);
    const line = `${JSON.stringify(entry)}\n`;
    (LEVELS[lvl] >= LEVELS.warn ? process.stderr : process.stdout).write(line);
  };
  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}

/**
 * File-set IDs are bearer secrets, so they are never logged. Logs use a short,
 * non-reversible reference instead, which is still stable for correlation.
 */
function setRef(id) {
  return `set:${crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 12)}`;
}

/** Replace anything that looks like a file-set ID inside a URL path. */
function redactIds(urlPath) {
  return urlPath.replace(/[A-Za-z0-9_-]{43}/g, (m) => setRef(m));
}

module.exports = { createLogger, setRef, redactIds };
