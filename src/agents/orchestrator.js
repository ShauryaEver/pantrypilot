'use strict';
const llm = require('../lib/llm');
const metrics = require('../lib/metrics');
const { todayUTC, constraintViolations } = require('../lib/domain');
const inventory = require('./inventory');
const planner = require('./planner');
const critic = require('./critic');

/**
 * Agentic loop: Inventory -> Planner (Gemini) -> Critic -> (retry with feedback) -> Finalize.
 * Every step is traced so the UI can show *why* the system decided what it did.
 */
async function runPlan({ items, profile, days = 3 }) {
  const trace = [];
  const step = async (agent, fn) => {
    const t0 = Date.now();
    const out = await fn();
    trace.push({ agent, ms: Date.now() - t0, note: out.note });
    return out.value;
  };

  const today = todayUTC();
  const risk = await step('inventory', async () => {
    const r = inventory.assess(items, today);
    return { value: r, note: `${r.expiring.length} items need attention, ${r.expired.length} already expired` };
  });

  // Items the user cannot eat (allergen/diet) are never fed to the planner at all.
  const edible = (i) => constraintViolations(i.name, profile).length === 0;
  const pantryNames = risk.all.filter((i) => i.urgency !== 'expired' && edible(i)).map((i) => i.name);
  risk.expiring = risk.expiring.filter(edible);
  if (!risk.expiring.length) {
    return { plan: { meals: [], tips: ['Nothing is close to expiring. Nice work!'] }, mode: 'idle', trace, coverage: 1, risk };
  }

  const target = risk.expiring.slice(0, 12);
  let mode = 'offline';
  let draft;

  if (llm.isAvailable()) {
    try {
      const r = await step('planner', async () => {
        const out = await planner.planWithLlm({ expiring: target, pantryNames, profile, days, userId: profile.id });
        return { value: out.plan, note: `Gemini drafted ${out.plan.meals.length} meals${out.cached ? ' (cache hit)' : ` in ${out.ms}ms`}` };
      });
      draft = r;
      mode = 'gemini';
    } catch (err) {
      metrics.state.llm.fallbacks++;
      trace.push({ agent: 'planner', ms: 0, note: `Gemini failed (${err.message}); using offline planner` });
    }
  }
  if (!draft) {
    draft = await step('planner', async () => ({ value: planner.planOffline({ expiring: target, days }), note: 'Rule-based planner' }));
  }

  let review = await step('critic', async () => {
    const r = critic.review(draft, { pantryNames, profile });
    return { value: r, note: `${r.meals.length} safe, ${r.violations.length} violations, ${r.ungrounded} ungrounded names fixed` };
  });

  // One reflective retry when the critic rejected something and we are using the LLM.
  if (review.violations.length && mode === 'gemini') {
    try {
      const retry = await step('planner-retry', async () => {
        const out = await planner.planWithLlm({ expiring: target, pantryNames, profile, days, feedback: review.violations, userId: profile.id });
        return { value: out.plan, note: 'Re-planned using critic feedback' };
      });
      const second = await step('critic', async () => {
        const r = critic.review(retry, { pantryNames, profile });
        return { value: r, note: `${r.meals.length} safe, ${r.violations.length} violations` };
      });
      if (second.meals.length >= review.meals.length) review = second;
    } catch (_) { /* keep first review: unsafe meals are already stripped */ }
  }

  // Guaranteed-safe fallback if the critic removed everything.
  if (!review.meals.length) {
    const off = planner.planOffline({ expiring: target, days });
    const r = critic.review(off, { pantryNames, profile });
    review = { ...r, violations: review.violations };
    mode = 'offline';
    trace.push({ agent: 'finalize', ms: 0, note: 'All AI meals rejected; fell back to safe rule-based plan' });
  }

  const used = new Set(review.meals.flatMap((m) => m.uses.map((u) => u.toLowerCase())));
  const covered = target.filter((i) => used.has(i.name.toLowerCase()));
  const coverage = target.length ? covered.length / target.length : 1;

  return {
    plan: { meals: review.meals, tips: draft.tips || [] },
    mode,
    trace,
    coverage,
    covered,
    risk,
    guardrail: { violationsBlocked: review.violations.length, details: review.violations.slice(0, 5) },
  };
}

module.exports = { runPlan };
