'use strict';

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { SetStore } = require('./store');
const { createServer } = require('./server');

let log = createLogger(process.env.LOG_LEVEL || 'info');

process.on('unhandledRejection', (reason) => {
  log.error('unhandled promise rejection; exiting', { err: reason });
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  log.error('uncaught exception; exiting', { err });
  process.exit(1);
});

async function main() {
  const config = loadConfig();
  log = createLogger(config.logLevel);
  const { dataDir, maxSets, maxSetBytes, minTtlSeconds, maxTtlSeconds } = config;
  log.info('starting share-app', { node: process.version, dataDir, maxSets, maxSetBytes, minTtlSeconds, maxTtlSeconds });

  const state = { shuttingDown: false };
  const store = new SetStore(config, log);
  await store.init();

  const server = createServer({ config, store, log, state });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  server.on('error', (err) => log.error('server error', { err }));
  log.info('listening', { host: config.host, port: config.port });

  const shutdown = (signal) => {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    log.info('shutdown requested; draining connections', { signal, graceSeconds: config.shutdownGraceSeconds });
    store.close();
    server.close(() => {
      log.info('all connections closed; exiting');
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => {
      // Interrupted uploads are discarded on next start (their temp files are removed).
      log.warn('grace period over; exiting with transfers still in flight');
      process.exit(0);
    }, config.shutdownGraceSeconds * 1000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('startup failed', { err });
  process.exit(1);
});
