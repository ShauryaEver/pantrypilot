'use strict';
const config = require('./config');
const log = require('./lib/log');
const { createApp } = require('./app');
const store = require('./store');

const app = createApp();
const server = app.listen(config.port, () => {
  log.info('PantryPilot listening', {
    port: config.port, env: config.env, database: store.name, ai: config.aiMode(),
    models: { plan: config.geminiModel, parse: config.geminiParseModel },
    firebase_auth: config.firebase.adminEnabled, firestore_log: config.firebase.firestoreLog, bigquery_stream: config.bigquery.enabled,
  });
});

// Graceful shutdown for Cloud Run (SIGTERM) so in-flight requests finish.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
