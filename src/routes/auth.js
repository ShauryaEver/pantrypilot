'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const config = require('../config');
const store = require('../store');
const firebase = require('../integrations/firebase');
const { COOKIE, issueSession, requireAuth, validate, authLimiter } = require('../middleware/security');
const { DIETS, ALLERGENS } = require('../lib/domain');

const router = express.Router();

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10, 'Use at least 10 characters').max(128),
});
const profileInput = z.object({
  diet: z.enum(DIETS),
  allergens: z.array(z.enum(ALLERGENS)).max(ALLERGENS.length).transform((a) => [...new Set(a)]),
  household: z.number().int().min(1).max(12),
});
const googleInput = z.object({ idToken: z.string().min(20).max(4096) });
const deleteInput = z.object({ password: z.string().max(128).optional(), idToken: z.string().min(20).max(4096).optional() });

// Constant-time-ish defence against user enumeration: always compare against *some* hash.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', config.bcryptRounds);

const publicUser = (u) => ({ id: u.id, email: u.email, diet: u.diet, allergens: u.allergens, household: u.household });

router.post('/register', authLimiter, validate(credentials), async (req, res) => {
  const { email, password } = req.valid;
  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
  try {
    const user = await store.createUser({ email, passwordHash });
    issueSession(res, user);
    store.safeAudit(user.id, 'register', null, req.ip);
    res.status(201).json({ user: publicUser(user) });
  } catch (e) {
    if (e.code === 'DUPLICATE') return res.status(409).json({ error: 'Could not create account' });
    throw e;
  }
});

router.post('/login', authLimiter, validate(credentials), async (req, res) => {
  const { email, password } = req.valid;
  const user = await store.getUserByEmail(email);
  const now = Date.now();

  if (user && user.locked_until > now) {
    store.safeAudit(user.id, 'login_locked', null, req.ip);
    return res.status(429).json({ error: 'Account temporarily locked. Try again later.' });
  }

  // Google-only accounts have no password hash: compare against the dummy so timing and message are identical.
  const ok = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);
  if (!user || !user.password_hash || !ok) {
    if (user) {
      const failures = user.failed_logins + 1;
      const lock = failures >= config.lockout.maxFailures ? now + config.lockout.durationMs : 0;
      await store.setLoginState(user.id, lock ? 0 : failures, lock);
      store.safeAudit(user.id, lock ? 'account_locked' : 'login_failed', null, req.ip);
    }
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  await store.setLoginState(user.id, 0, 0);
  issueSession(res, user);
  store.safeAudit(user.id, 'login', null, req.ip);
  res.json({ user: publicUser(user) });
});

/**
 * "Continue with Google": the browser signs in with Firebase Auth and sends us the ID token.
 * We never trust the browser's claim; the Admin SDK verifies signature, audience, expiry and revocation,
 * and requires a verified email. Only then do we issue our own HttpOnly session cookie.
 */
router.post('/google', authLimiter, validate(googleInput), async (req, res) => {
  if (!firebase.enabled()) return res.status(503).json({ error: 'Google sign-in is not configured' });
  let identity;
  try {
    identity = await firebase.verifyIdToken(req.valid.idToken, req.app.locals.firebaseVerifier);
  } catch (e) {
    store.safeAudit(null, 'google_login_rejected', e.message, req.ip);
    return res.status(401).json({ error: 'Google sign-in could not be verified' });
  }
  let user = await store.getUserByFirebaseUid(identity.uid);
  if (!user) {
    user = await store.getUserByEmail(identity.email); // same verified email: link to the existing account
    if (user) await store.linkFirebaseUid(user.id, identity.uid);
    else user = await store.createUser({ email: identity.email, firebaseUid: identity.uid });
  }
  issueSession(res, user);
  store.safeAudit(user.id, 'login_google', null, req.ip);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => res.json({ user: { ...publicUser(req.user), has_password: req.user.hasPassword } }));

router.put('/profile', requireAuth, validate(profileInput), async (req, res) => {
  const { diet, allergens, household } = req.valid;
  await store.updateProfile(req.user.id, { diet, allergens, household });
  store.safeAudit(req.user.id, 'profile_update', null, req.ip);
  res.json({ user: publicUser({ ...req.user, diet, allergens, household }) });
});

/** Data portability: everything we hold about the user as JSON. */
router.get('/export', requireAuth, async (req, res) => {
  const data = await store.exportAll(req.user.id);
  res.setHeader('Content-Disposition', 'attachment; filename="pantrypilot-export.json"');
  res.json({ user: publicUser(req.user), ...data });
});

/** Right to erasure. Password accounts confirm with the password; Google-only accounts re-authenticate with a fresh token. */
router.delete('/account', requireAuth, validate(deleteInput), async (req, res) => {
  const row = await store.getUserById(req.user.id);
  let ok = false;
  if (row.password_hash && req.valid.password) {
    ok = await bcrypt.compare(req.valid.password, row.password_hash);
  } else if (row.firebase_uid && req.valid.idToken && firebase.enabled()) {
    try {
      const id = await firebase.verifyIdToken(req.valid.idToken, req.app.locals.firebaseVerifier);
      ok = id.uid === row.firebase_uid && Date.now() / 1000 - id.authTime < 300; // signed in within the last 5 minutes
    } catch (_) { ok = false; }
  }
  if (!ok) return res.status(401).json({ error: row.password_hash ? 'Incorrect password' : 'Please sign in with Google again to confirm' });
  store.safeAudit(req.user.id, 'account_deleted', null, req.ip);
  await store.deleteUser(req.user.id);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

module.exports = router;
