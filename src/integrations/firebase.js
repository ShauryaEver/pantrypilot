'use strict';
// Firebase: Authentication (verify Google sign-in tokens server-side) and Firestore (anonymous agent-run log).
const crypto = require('crypto');
const config = require('../config');
const log = require('../lib/log');

let adminApp = null;
function admin() {
  if (!config.firebase.adminEnabled) return null;
  if (!adminApp) {
    const fb = require('firebase-admin');
    if (fb.apps.length) adminApp = fb.app();
    else {
      const credential = config.firebase.serviceAccountJson ? fb.credential.cert(JSON.parse(config.firebase.serviceAccountJson)) : fb.credential.applicationDefault();
      adminApp = fb.initializeApp({ credential, projectId: config.firebase.web.projectId });
    }
  }
  return adminApp;
}
const enabled = () => config.firebase.adminEnabled;

/** Verifies a Firebase ID token (signature, audience, expiry AND revocation). Throws if invalid. */
async function verifyIdToken(idToken, verifier) {
  const check = verifier || ((t) => admin().auth().verifyIdToken(t, true));
  const decoded = await check(idToken);
  if (!decoded.email || decoded.email_verified !== true) {
    const e = new Error('Google account email is not verified');
    e.status = 401;
    throw e;
  }
  return { uid: decoded.uid, email: String(decoded.email).toLowerCase(), authTime: Number(decoded.auth_time) || 0 };
}

const pseudo = (id) => crypto.createHash('sha256').update(`${config.bigquery.salt || config.jwtSecret}:${id}`).digest('hex').slice(0, 16);

/** Fire-and-forget Firestore log of each agent run. No emails, no item names: only anonymous operational data. */
function logAgentRun(userId, run) {
  if (!config.firebase.firestoreLog || !admin()) return;
  try {
    const fb = require('firebase-admin');
    admin().firestore().collection('agent_runs').add({
      user: pseudo(userId),
      mode: run.mode,
      coverage: run.coverage,
      violationsBlocked: run.violationsBlocked,
      steps: run.trace.map((t) => ({ agent: t.agent, ms: t.ms })),
      at: fb.firestore.FieldValue.serverTimestamp(),
    }).catch((e) => log.warn('firestore log failed', { err: e.message }));
  } catch (e) { log.warn('firestore log failed', { err: e.message }); }
}

module.exports = { enabled, verifyIdToken, logAgentRun, pseudo };
