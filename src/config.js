'use strict';
const crypto = require('crypto');
const path = require('path');

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';
const isTest = env === 'test';
const str = (k, d = '') => (process.env[k] ?? d).trim();
const num = (k, d) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d);
const bool = (k) => /^(1|true|yes)$/i.test(str(k));

let jwtSecret = str('JWT_SECRET');
if (!jwtSecret) {
  if (isProd) throw new Error('JWT_SECRET must be set in production');
  // Ephemeral secret in dev/test: sessions reset on restart, which is the safe default.
  jwtSecret = crypto.randomBytes(32).toString('hex');
}

// Gemini runs through Vertex AI (no API key, uses the Cloud Run service account) when GOOGLE_GENAI_USE_VERTEXAI=true,
// otherwise through the Gemini API with GEMINI_API_KEY.
const useVertex = bool('GOOGLE_GENAI_USE_VERTEXAI');
const gcpProject = str('GOOGLE_CLOUD_PROJECT') || str('GCLOUD_PROJECT');

// Supabase is the production database; local SQLite is the zero-setup fallback.
const supabase = { url: str('SUPABASE_URL'), serviceKey: str('SUPABASE_SERVICE_ROLE_KEY') };
const useSupabase = !isTest && Boolean(supabase.url && supabase.serviceKey);

const firebaseWeb = {
  apiKey: str('FIREBASE_API_KEY'),
  authDomain: str('FIREBASE_AUTH_DOMAIN'),
  projectId: str('FIREBASE_PROJECT_ID') || gcpProject,
  appId: str('FIREBASE_APP_ID'),
};
const firebaseWebEnabled = Boolean(firebaseWeb.apiKey && firebaseWeb.authDomain && firebaseWeb.projectId && firebaseWeb.appId);

module.exports = {
  env, isProd, isTest,
  port: Number(process.env.PORT) || 8080,
  jwtSecret,
  jwtTtlSeconds: 2 * 60 * 60,
  bcryptRounds: isTest ? 4 : 12,

  // database
  dbPath: isTest ? ':memory:' : str('DB_PATH') || path.join(process.cwd(), 'data', 'pantrypilot.db'),
  supabase, useSupabase,

  // Google Firebase (Auth via Admin SDK on the server, Firestore for the agent-run log)
  firebase: {
    web: firebaseWeb,
    webEnabled: firebaseWebEnabled,
    // Admin SDK uses Application Default Credentials on Cloud Run; locally set GOOGLE_APPLICATION_CREDENTIALS
    // or FIREBASE_SERVICE_ACCOUNT_JSON (single-line JSON).
    adminEnabled: !isTest && Boolean(firebaseWeb.projectId) && (firebaseWebEnabled || bool('FIREBASE_ADMIN')),
    serviceAccountJson: str('FIREBASE_SERVICE_ACCOUNT_JSON'),
    firestoreLog: !isTest && bool('FIRESTORE_AGENT_LOG'),
  },

  // AI
  geminiKey: str('GEMINI_API_KEY'),
  useVertex,
  gcpProject,
  gcpLocation: str('GOOGLE_CLOUD_LOCATION', 'us-central1'),
  geminiModel: str('GEMINI_MODEL', 'gemini-2.5-flash'),          // planning (needs reasoning)
  geminiParseModel: str('GEMINI_PARSE_MODEL', 'gemini-2.5-flash-lite'), // receipt parsing (cheap, simple extraction)
  llmTimeoutMs: num('LLM_TIMEOUT_MS', 25000),
  llmCacheTtlMs: 60 * 60 * 1000,
  aiDailyLimit: num('AI_DAILY_LIMIT', 50), // per user per UTC day: caps abuse and cost
  // USD per 1M tokens, used only for the cost estimate shown in Settings. Check current Google pricing and override.
  pricing: {
    inputPerM: Number(process.env.PRICE_INPUT_PER_M ?? 0.30),
    outputPerM: Number(process.env.PRICE_OUTPUT_PER_M ?? 2.50),
  },

  // BigQuery live streaming (optional)
  bigquery: {
    enabled: !isTest && bool('BQ_STREAM'),
    dataset: str('BQ_DATASET', 'pantrypilot'),
    table: str('BQ_TABLE', 'waste_events'),
    salt: str('BQ_SALT'),
    projectId: str('BQ_PROJECT_ID') || gcpProject,
  },

  maxPantryItems: 500,
  lockout: { maxFailures: 5, durationMs: 15 * 60 * 1000 },
};
module.exports.aiMode = () => (module.exports.useVertex ? 'vertex' : module.exports.geminiKey ? 'gemini-api' : 'offline');
