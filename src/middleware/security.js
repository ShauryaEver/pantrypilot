'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const config = require('../config');
const log = require('../lib/log');
const store = require('../store');

const COOKIE = 'pp_token';

// Firebase Google sign-in loads Google-hosted scripts and talks to Google identity endpoints; these origins are
// added to the CSP only when Firebase is configured. Everything else stays locked to 'self'.
const fbOn = config.firebase.webEnabled;
const fbAuthHost = config.firebase.web.authDomain ? `https://${config.firebase.web.authDomain}` : null;
const helmetMw = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", ...(fbOn ? ['https://www.gstatic.com', 'https://apis.google.com'] : [])],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", ...(fbOn ? ['https://identitytoolkit.googleapis.com', 'https://securetoken.googleapis.com', 'https://www.googleapis.com'] : [])],
      frameSrc: ["'self'", ...(fbOn ? [fbAuthHost, 'https://accounts.google.com'].filter(Boolean) : [])],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  // Popup-based Google sign-in needs window.opener access to its own popup.
  crossOriginOpenerPolicy: { policy: fbOn ? 'same-origin-allow-popups' : 'same-origin' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
});

const limiter = (opts) =>
  rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => config.isTest && !opts.testable,
    message: { error: 'Too many requests, slow down.' },
    ...opts,
  });

const globalLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 600 });
const authLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 30 });
const agentLimiter = limiter({ windowMs: 60 * 1000, limit: 10 });

/** CSRF defence in depth: SameSite=Strict cookie + required custom header on state-changing calls. */
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'pantrypilot') {
    return res.status(403).json({ error: 'Missing CSRF header' });
  }
  next();
}

function issueSession(res, user) {
  const token = jwt.sign({ sub: String(user.id), jti: crypto.randomUUID() }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: config.jwtTtlSeconds,
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.isProd,
    maxAge: config.jwtTtlSeconds * 1000,
    path: '/',
  });
}

async function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch (_) {
    res.clearCookie(COOKIE);
    return res.status(401).json({ error: 'Session expired' });
  }
  // A database failure is a 500 (via the error handler), not a logout.
  const u = await store.getUserById(Number(payload.sub));
  if (!u) return res.status(401).json({ error: 'Not authenticated' });
  req.user = { id: u.id, email: u.email, diet: u.diet, allergens: u.allergens, household: u.household, hasPassword: Boolean(u.password_hash) };
  next();
}

const validate = (schema, where = 'body') => (req, res, next) => {
  const r = schema.safeParse(req[where]);
  if (!r.success) {
    return res.status(400).json({
      error: 'Invalid input',
      issues: r.error.issues.slice(0, 8).map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  req.valid = r.data;
  next();
};

function errorHandler(err, req, res, _next) {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
  store.safeAudit(req.user?.id, 'server_error', err.message, req.ip);
  log.error('unhandled error', { err: err.message, path: req.path });
  // Never leak stack traces or internals to clients.
  res.status(500).json({ error: 'Internal server error' });
}

module.exports = { COOKIE, helmetMw, globalLimiter, authLimiter, agentLimiter, csrfGuard, issueSession, requireAuth, validate, errorHandler };
