'use strict';
process.env.NODE_ENV = 'test';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const config = require('../src/config');
const store = require('../src/store');
const llm = require('../src/lib/llm');
const metrics = require('../src/lib/metrics');
const firebase = require('../src/integrations/firebase');
const bigquery = require('../src/integrations/bigquery');

function fakeGenAi() {
  const calls = [];
  return {
    calls,
    models: {
      async generateContent(req) {
        calls.push(req);
        return { text: '```json\n{"ok":true}\n```', usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200 } };
      },
    },
  };
}

let ai;
beforeEach(() => { ai = fakeGenAi(); llm._setClientForTest(ai); config.aiDailyLimit = 50; });

test('Gemini calls: safety filters on, model override honoured, tokens counted, fenced JSON parsed', async () => {
  const before = { ...metrics.state.llm };
  const r = await llm.generateJson({ system: 's', prompt: 'p1', model: 'gemini-2.5-flash-lite' });
  assert.deepEqual(r.data, { ok: true });
  const req = ai.calls[0];
  assert.equal(req.model, 'gemini-2.5-flash-lite');
  assert.equal(req.config.safetySettings.length, 4);
  assert.ok(req.config.safetySettings.every((s) => s.threshold === 'BLOCK_MEDIUM_AND_ABOVE'));
  assert.equal(req.config.responseMimeType, 'application/json');
  assert.equal(metrics.state.llm.inputTokens - before.inputTokens, 1000);
  assert.equal(metrics.state.llm.outputTokens - before.outputTokens, 200);
});

test('efficiency: identical prompts are served from cache (memory then database) without a second model call', async () => {
  await llm.generateJson({ system: 's', prompt: 'cache-me' });
  const second = await llm.generateJson({ system: 's', prompt: 'cache-me' });
  assert.equal(second.cached, true);
  assert.equal(ai.calls.length, 1);
  // Fresh process memory (simulated): the database tier still answers.
  llm._setClientForTest(ai);
  const third = await llm.generateJson({ system: 's', prompt: 'cache-me' });
  assert.equal(third.cached, true);
  assert.equal(ai.calls.length, 1);
});

test('security/cost: per-user daily AI quota blocks the call, but cached answers stay free', async () => {
  const u = await store.createUser({ email: `quota${Date.now()}@x.co`, passwordHash: 'h' });
  config.aiDailyLimit = 2;
  await llm.generateJson({ system: 's', prompt: 'q1', userId: u.id });
  await llm.generateJson({ system: 's', prompt: 'q2', userId: u.id });
  const blockedBefore = metrics.state.llm.quotaBlocked;
  await assert.rejects(llm.generateJson({ system: 's', prompt: 'q3', userId: u.id }), (e) => e.status === 429 && e.code === 'AI_QUOTA');
  assert.equal(metrics.state.llm.quotaBlocked, blockedBefore + 1);
  assert.equal(ai.calls.length, 2); // the blocked call never reached the model
  const hit = await llm.generateJson({ system: 's', prompt: 'q1', userId: u.id });
  assert.equal(hit.cached, true);
  // another user is unaffected
  const v = await store.createUser({ email: `other${Date.now()}@x.co`, passwordHash: 'h' });
  await llm.generateJson({ system: 's', prompt: 'q3', userId: v.id });
});

test('a model failure is counted and surfaced (the orchestrator then falls back to the offline planner)', async () => {
  llm._setClientForTest({ models: { async generateContent() { throw new Error('boom'); } } });
  const f = metrics.state.llm.failures;
  await assert.rejects(llm.generateJson({ system: 's', prompt: 'fails' }), /boom/);
  assert.equal(metrics.state.llm.failures, f + 1);
});

test('cost estimate uses the configured token prices', () => {
  const cost = metrics.estimateCostUsd(1_000_000, 1_000_000);
  assert.equal(+cost.toFixed(2), +(config.pricing.inputPerM + config.pricing.outputPerM).toFixed(2));
});

test('Firebase: only verified-email Google identities are accepted; email is normalised', async () => {
  const ok = await firebase.verifyIdToken('t', async () => ({ uid: 'u1', email: 'Mixed@Case.com', email_verified: true, auth_time: 1700000000 }));
  assert.deepEqual(ok, { uid: 'u1', email: 'mixed@case.com', authTime: 1700000000 });
  await assert.rejects(firebase.verifyIdToken('t', async () => ({ uid: 'u1', email: 'a@b.co', email_verified: false })), /not verified/);
  await assert.rejects(firebase.verifyIdToken('t', async () => ({ uid: 'u1', email_verified: true })), /not verified/);
  await assert.rejects(firebase.verifyIdToken('t', async () => { throw new Error('token expired'); }), /expired/);
});

test('BigQuery stream: pseudonymised user, no email, and failures never throw', async () => {
  const rows = [];
  await bigquery.streamEvent(42, { item_name: 'Spinach', category: 'produce', kind: 'rescued', cost: 40, co2_kg: 0.1 }, { insert: async (r) => rows.push(...r) });
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].user, '42');
  assert.match(rows[0].user, /^[0-9a-f]{16}$/);
  assert.equal(rows[0].kind, 'rescued');
  assert.ok(!JSON.stringify(rows[0]).includes('@'));
  await bigquery.streamEvent(42, { item_name: 'x', category: 'y', kind: 'used', cost: 0, co2_kg: 0 }, { insert: async () => { throw new Error('bq down'); } });
});

function configIn(env) {
  const out = execFileSync(process.execPath, ['-e', "const c=require('./src/config');console.log(JSON.stringify({mode:c.aiMode(),sb:c.useSupabase,fb:c.firebase.webEnabled,adm:c.firebase.adminEnabled,bq:c.bigquery.enabled}))"], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  return JSON.parse(out.trim());
}
test('config: key-only, Vertex, Supabase and Firebase modes resolve correctly', () => {
  assert.deepEqual(configIn({ NODE_ENV: 'development' }), { mode: 'offline', sb: false, fb: false, adm: false, bq: false });
  assert.equal(configIn({ NODE_ENV: 'development', GEMINI_API_KEY: 'k' }).mode, 'gemini-api');
  assert.equal(configIn({ NODE_ENV: 'development', GOOGLE_GENAI_USE_VERTEXAI: 'true', GOOGLE_CLOUD_PROJECT: 'p' }).mode, 'vertex');
  assert.equal(configIn({ NODE_ENV: 'development', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' }).sb, true);
  assert.equal(configIn({ NODE_ENV: 'development', SUPABASE_URL: 'https://x.supabase.co' }).sb, false); // URL alone is not enough
  const fb = configIn({ NODE_ENV: 'development', FIREBASE_API_KEY: 'a', FIREBASE_AUTH_DOMAIN: 'd', FIREBASE_PROJECT_ID: 'p', FIREBASE_APP_ID: 'i' });
  assert.deepEqual([fb.fb, fb.adm], [true, true]);
  assert.equal(configIn({ NODE_ENV: 'development', BQ_STREAM: 'true' }).bq, true);
  assert.throws(() => configIn({ NODE_ENV: 'production' }), /JWT_SECRET/);
});
