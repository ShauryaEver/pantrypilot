'use strict';
// Lightweight in-process telemetry: request latency percentiles + LLM efficiency counters + token/cost estimate.
const config = require('../config');
const WINDOW = 500;
const latencies = [];
const state = {
  startedAt: Date.now(),
  requests: 0,
  errors5xx: 0,
  llm: { calls: 0, cacheHits: 0, fallbacks: 0, failures: 0, quotaBlocked: 0, totalMs: 0, inputTokens: 0, outputTokens: 0 },
};

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function middleware(req, res, next) {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    state.requests++;
    if (res.statusCode >= 500) state.errors5xx++;
    latencies.push(ms);
    if (latencies.length > WINDOW) latencies.shift();
  });
  next();
}

const estimateCostUsd = (inTok, outTok) => (inTok * config.pricing.inputPerM + outTok * config.pricing.outputPerM) / 1e6;

function snapshot() {
  const sorted = [...latencies].sort((a, b) => a - b);
  const { calls, cacheHits, totalMs, inputTokens, outputTokens } = state.llm;
  return {
    uptime_s: Math.round((Date.now() - state.startedAt) / 1000),
    requests: state.requests,
    errors_5xx: state.errors5xx,
    latency_ms: { p50: +percentile(sorted, 50).toFixed(2), p95: +percentile(sorted, 95).toFixed(2), samples: sorted.length },
    llm: {
      ...state.llm,
      cache_hit_rate: calls + cacheHits ? +(cacheHits / (calls + cacheHits)).toFixed(3) : 0,
      avg_ms: calls ? Math.round(totalMs / calls) : 0,
      tokens_total: inputTokens + outputTokens,
      est_cost_usd: +estimateCostUsd(inputTokens, outputTokens).toFixed(5),
      est_cost_per_call_usd: calls ? +(estimateCostUsd(inputTokens, outputTokens) / calls).toFixed(5) : 0,
      est_saved_by_cache_usd: calls ? +((estimateCostUsd(inputTokens, outputTokens) / calls) * cacheHits).toFixed(5) : 0,
    },
    ai: { mode: config.aiMode(), daily_limit_per_user: config.aiDailyLimit, database: config.useSupabase ? 'supabase' : 'sqlite' },
  };
}

module.exports = { state, middleware, snapshot, estimateCostUsd };
