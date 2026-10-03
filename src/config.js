'use strict';

const path = require('node:path');

const HARD_MAX_TTL_SECONDS = 6 * 60 * 60; // product requirement: never more than 6 hours

function int(name, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`Invalid configuration: ${name} must be a non-negative integer, got "${raw}"`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Invalid configuration: ${name} must be between ${min} and ${max}, got ${raw}`);
  }
  return value;
}

function loadConfig() {
  const maxTtlSeconds = int('MAX_TTL_SECONDS', HARD_MAX_TTL_SECONDS, { min: 1, max: HARD_MAX_TTL_SECONDS });
  const minTtlSeconds = int('MIN_TTL_SECONDS', 60, { min: 1, max: maxTtlSeconds });
  const logLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new Error(`Invalid configuration: LOG_LEVEL must be debug|info|warn|error, got "${logLevel}"`);
  }
  return Object.freeze({
    host: process.env.HOST || '0.0.0.0',
    port: int('PORT', 8080, { min: 1, max: 65535 }),
    dataDir: path.resolve(process.env.DATA_DIR || './data'),
    maxSets: int('MAX_SETS', 10, { min: 1 }),
    maxSetBytes: int('MAX_SET_BYTES', 5 * 1024 ** 3, { min: 1 }), // 5 GiB
    maxFilesPerSet: int('MAX_FILES_PER_SET', 1000, { min: 1 }),
    minTtlSeconds,
    maxTtlSeconds,
    sweepIntervalSeconds: int('SWEEP_INTERVAL_SECONDS', 15, { min: 1, max: 3600 }),
    // Browser uploads are sent in chunks of this size. Keep it well below any
    // proxy body limit in front of the cluster (Cloudflare Free/Pro: 100 MB).
    chunkBytes: int('CHUNK_BYTES', 32 * 1024 ** 2, { min: 1024 ** 2, max: 1024 ** 3 }),
    // A chunked upload with no new chunk for this long is discarded and its quota released.
    uploadSessionIdleSeconds: int('UPLOAD_SESSION_IDLE_SECONDS', 900, { min: 1 }),
    // A transfer with no bytes moving for this long is aborted.
    idleTimeoutSeconds: int('IDLE_TIMEOUT_SECONDS', 120, { min: 5 }),
    // Keep this much disk free beyond what in-flight uploads have reserved.
    diskReserveBytes: int('DISK_RESERVE_BYTES', 256 * 1024 ** 2),
    shutdownGraceSeconds: int('SHUTDOWN_GRACE_SECONDS', 20, { min: 0, max: 3600 }),
    trustProxy: (process.env.TRUST_PROXY || 'true').toLowerCase() !== 'false',
    logLevel,
  });
}

module.exports = { loadConfig, HARD_MAX_TTL_SECONDS };
