'use strict';
const config = require('./config');
const log = require('./lib/log');
const { createApp } = require('./app');
const store = require('./store');

const app = createApp();

// Locally we listen on a port; on Vercel the exported app is used instead.
if (require.main === module) {
  const server = app.listen(config.port, () => {
    log.info('PantryPilot listening', { port: config.port, env: config.env, database: store.name, ai: config.aiMode() });
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
}

module.exports = app;