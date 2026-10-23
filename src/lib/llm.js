'use strict';
const crypto = require('crypto');
const config = require('../config');
const store = require('../store');
const metrics = require('./metrics');

let client = null;
let forced = false; // tests inject a fake client
function getClient() {
  if (client) return client;
  if (!isAvailable()) return null;
  const { GoogleGenAI } = require('@google/genai');
  client = config.useVertex
    ? new GoogleGenAI({ vertexai: true, project: config.gcpProject, location: config.gcpLocation }) // auth = service account, no API key
    : new GoogleGenAI({ apiKey: config.geminiKey });
  return client;
}

function isAvailable() {
  if (forced) return true;
  if (config.isTest) return false;
  return config.useVertex ? Boolean(config.gcpProject) : Boolean(config.geminiKey);
}

// Gemini safety filters ON (block medium+ for every harm category). Stops the model emitting harmful content.
const SAFETY = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
  .map((category) => ({ category, threshold: 'BLOCK_MEDIUM_AND_ABOVE' }));

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('LLM timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function parseJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

// Tier 1 cache: in-memory (zero latency). Tier 2: database (shared across instances and restarts).
const mem = new Map();
const MEM_MAX = 200;
const memGet = (k) => { const e = mem.get(k); if (e && Date.now() - e.at < config.llmCacheTtlMs) return e.value; mem.delete(k); return null; };
const memSet = (k, v) => { if (mem.size >= MEM_MAX) mem.delete(mem.keys().next().value); mem.set(k, { value: v, at: Date.now() }); };

const utcDay = () => new Date().toISOString().slice(0, 10);

function quotaError() {
  const e = new Error(`Daily AI limit of ${config.aiDailyLimit} calls reached`);
  e.status = 429;
  e.code = 'AI_QUOTA';
  return e;
}

/**
 * Calls Gemini expecting JSON. Order: memory cache -> DB cache -> per-user daily quota -> model.
 * Cache hits are free and do not count against the quota. Callers must still validate the result against a schema.
 * Returns { data, cached, ms } or throws.
 */
async function generateJson({ system, prompt, parts, temperature = 0.4, cache = true, model = config.geminiModel, userId = null }) {
  const ai = getClient();
  if (!ai || !isAvailable()) throw new Error('LLM unavailable');

  const key = crypto.createHash('sha256').update(JSON.stringify([model, system, prompt, parts ? 'img' : '', temperature])).digest('hex');
  if (cache && !parts) {
    const hit = memGet(key) || (await store.cacheGet(key, Date.now() - config.llmCacheTtlMs).catch(() => null));
    if (hit) {
      memSet(key, hit);
      metrics.state.llm.cacheHits++;
      return { data: hit, cached: true, ms: 0 };
    }
  }

  // Security + cost control: each user gets a daily budget of real model calls.
  if (userId != null) {
    const used = await store.incrementUsage(userId, utcDay());
    if (used > config.aiDailyLimit) { metrics.state.llm.quotaBlocked++; throw quotaError(); }
  }

  const t0 = Date.now();
  metrics.state.llm.calls++;
  try {
    const contents = parts ? [{ role: 'user', parts: [...parts, { text: prompt }] }] : prompt;
    const res = await withTimeout(
      ai.models.generateContent({
        model,
        contents,
        config: { systemInstruction: system, responseMimeType: 'application/json', temperature, maxOutputTokens: 4096, safetySettings: SAFETY },
      }),
      config.llmTimeoutMs
    );
    const data = parseJson(res.text);
    const ms = Date.now() - t0;
    metrics.state.llm.totalMs += ms;
    metrics.state.llm.inputTokens += res.usageMetadata?.promptTokenCount || 0;
    metrics.state.llm.outputTokens += res.usageMetadata?.candidatesTokenCount || 0;
    if (cache && !parts) { memSet(key, data); store.cacheSet(key, data).catch(() => {}); }
    return { data, cached: false, ms };
  } catch (err) {
    metrics.state.llm.failures++;
    throw err;
  }
}

function pruneCache() {
  store.cachePrune(Date.now() - config.llmCacheTtlMs).catch(() => {});
}

const _setClientForTest = (c) => { client = c; forced = Boolean(c); mem.clear(); };

module.exports = { generateJson, isAvailable, pruneCache, SAFETY, _setClientForTest };
