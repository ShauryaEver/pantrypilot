'use strict';
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('./config');
const metrics = require('./lib/metrics');
const sec = require('./middleware/security');
const llm = require('./lib/llm');
const store = require('./store');
const firebase = require('./integrations/firebase');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.isProd ? 1 : false); // Cloud Run terminates TLS in front of us

  app.use(sec.helmetMw);
  app.use(metrics.middleware);
  app.use(sec.globalLimiter);
  // Small global body cap; the image route installs its own larger parser.
  const smallJson = express.json({ limit: '50kb' });
  app.use((req, res, next) => (req.path === '/api/pantry/parse-image' ? next() : smallJson(req, res, next)));
  app.use(cookieParser());

  // Liveness: process is up. Readiness: the database answers. Cloud Run / load balancers use these to route traffic.
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', ai: llm.isAvailable() ? config.aiMode() : 'offline-fallback' }));
  app.get('/api/ready', async (_req, res) => {
    try {
      await store.ping();
      res.json({ status: 'ready', database: store.name, ai: llm.isAvailable() ? config.aiMode() : 'offline-fallback', firebase_auth: firebase.enabled() });
    } catch (_) {
      res.status(503).json({ status: 'not ready', database: store.name });
    }
  });
  // Public, non-secret client config (Firebase web keys are identifiers, not secrets; access is enforced server-side).
  app.get('/api/config', (_req, res) => res.json({ firebase: config.firebase.webEnabled && firebase.enabled() ? config.firebase.web : null }));

  app.use('/api', sec.csrfGuard);
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/pantry', require('./routes/pantry'));
  app.use('/api/agent', require('./routes/agent'));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '1h' : 0, index: 'index.html' }));
  app.use(sec.errorHandler);

  if (!config.isTest) setInterval(llm.pruneCache, 30 * 60 * 1000).unref();
  return app;
}

module.exports = { createApp };
