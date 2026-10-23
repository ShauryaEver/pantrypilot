'use strict';
const express = require('express');
const { z } = require('zod');
const store = require('../store');
const firebase = require('../integrations/firebase');
const { requireAuth, validate, agentLimiter } = require('../middleware/security');
const { runPlan } = require('../agents/orchestrator');
const { co2For } = require('../lib/domain');
const { summarize } = require('../lib/impact');
const metrics = require('../lib/metrics');
const config = require('../config');

const router = express.Router();
router.use(requireAuth);

const planInput = z.object({ days: z.number().int().min(1).max(7).default(3) });

router.post('/plan', agentLimiter, validate(planInput), async (req, res) => {
  const items = await store.listActive(req.user.id);
  if (!items.length) return res.status(400).json({ error: 'Add some pantry items first' });

  const result = await runPlan({ items, profile: req.user, days: req.valid.days });

  const covered = result.covered || [];
  const money = covered.reduce((s, i) => s + (i.cost || 0), 0);
  const co2 = covered.reduce((s, i) => s + co2For(i), 0);
  const id = await store.insertPlan(req.user.id, { mode: result.mode, plan: result.plan, coverage: result.coverage, co2: +co2.toFixed(3), money: +money.toFixed(2) });
  store.safeAudit(req.user.id, 'plan_generated', `${result.mode} cov=${result.coverage.toFixed(2)}`, req.ip);
  firebase.logAgentRun(req.user.id, { mode: result.mode, coverage: +result.coverage.toFixed(2), violationsBlocked: result.guardrail?.violationsBlocked || 0, trace: result.trace });

  res.json({
    id,
    mode: result.mode,
    plan: result.plan,
    trace: result.trace,
    guardrail: result.guardrail || { violationsBlocked: 0, details: [] },
    stats: {
      coverage: +result.coverage.toFixed(2),
      expiring: result.risk.expiring.map((i) => ({ name: i.name, days_left: i.days_left, urgency: i.urgency })),
      expired: result.risk.expired.map((i) => ({ id: i.id, name: i.name, days_left: i.days_left })),
      projected_money: +money.toFixed(2),
      projected_co2_kg: +co2.toFixed(2),
    },
  });
});

router.get('/plans', async (req, res) => res.json({ plans: await store.listPlans(req.user.id) }));

router.get('/impact', async (req, res) => res.json(summarize(await store.impactEvents(req.user.id))));

router.get('/metrics', async (req, res) => {
  const used = await store.getUsage(req.user.id, new Date().toISOString().slice(0, 10));
  res.json({ ...metrics.snapshot(), ai_used_today: used, ai_daily_limit: config.aiDailyLimit });
});

module.exports = router;
