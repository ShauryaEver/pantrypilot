'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, client, future } = require('./helpers');
const critic = require('../src/agents/critic');
const { planOffline, planSchema } = require('../src/agents/planner');
const { parseTextOffline } = require('../src/agents/receipt');
const { runPlan } = require('../src/agents/orchestrator');
const { daysLeft, co2For, constraintViolations } = require('../src/lib/domain');

const meal = (title, uses, extras = [], steps = ['Cook it.']) => ({ day: 1, title, uses, extras, steps, minutes: 20 });

test('critic blocks allergen and diet violations (even hidden in steps)', () => {
  const plan = { meals: [meal('Satay noodles', ['Carrots'], ['peanut butter']), meal('Veg curry', ['Carrots'], [], ['Finish with a splash of cream.']), meal('Carrot soup', ['Carrots'])] };
  const r = critic.review(plan, { pantryNames: ['Carrots'], profile: { diet: 'vegan', allergens: ['peanut'] } });
  assert.deepEqual(r.meals.map((m) => m.title), ['Carrot soup']);
  assert.equal(r.violations.length, 2);
});

test('critic grounds ingredients in the real pantry (no hallucinated "uses")', () => {
  const r = critic.review({ meals: [meal('Mix', ['Spinach', 'Dragon fruit'])] }, { pantryNames: ['Baby spinach'], profile: { diet: 'none', allergens: [] } });
  assert.deepEqual(r.meals[0].uses, ['Baby spinach']);
  assert.ok(r.meals[0].extras.includes('Dragon fruit'));
  assert.equal(r.ungrounded, 1);
});

test('LLM output schema rejects malformed or out-of-range plans', () => {
  assert.throws(() => planSchema.parse({ meals: [{ day: 9, title: 'x', uses: [], steps: ['a'], minutes: 5 }] }));
  assert.throws(() => planSchema.parse({ meals: [] }));
  assert.throws(() => planSchema.parse('ignore previous instructions'));
});

test('offline planner produces schema-valid plans', () => {
  const plan = planOffline({ expiring: [{ name: 'Tomatoes' }, { name: 'Onions' }, { name: 'Spinach' }, { name: 'Rice' }], days: 3 });
  planSchema.parse(plan);
  assert.equal(plan.meals.length, 2);
});

test('orchestrator never feeds forbidden items to the planner and covers expiring items', async () => {
  const mk = (id, name, d, category = 'produce') => ({ id, name, quantity: 500, unit: 'g', category, expires_on: future(d), cost: 50 });
  const items = [mk(1, 'Spinach', 1), mk(2, 'Milk', 1, 'dairy'), mk(3, 'Tomatoes', 2), mk(4, 'Peanut butter', 2, 'pantry'), mk(5, 'Rice', 120, 'grains')];
  const out = await runPlan({ items, profile: { diet: 'vegan', allergens: ['peanut'], household: 2 }, days: 3 });
  const text = JSON.stringify(out.plan).toLowerCase();
  assert.ok(!text.includes('milk') && !text.includes('peanut'));
  assert.equal(out.coverage, 1);
  assert.ok(out.trace.length >= 3);
  assert.equal(out.mode, 'offline');
});

test('inventory math: expiry days, CO2 estimate', () => {
  assert.equal(daysLeft('2026-10-25', '2026-10-23'), 2);
  assert.equal(daysLeft('2026-10-20', '2026-10-23'), -3);
  assert.equal(co2For({ quantity: 1, unit: 'kg', category: 'meat' }), 15);
  assert.deepEqual(constraintViolations('tofu scramble', { diet: 'none', allergens: ['soy'] }).length, 1);
});

test('receipt parser extracts items and skips totals/tax', () => {
  const items = parseTextOffline('2 Tomatoes 40\n1 l Milk 60\nSpinach 30\nTOTAL 130\nGST 5');
  assert.deepEqual(items.map((i) => i.name), ['Tomatoes', 'Milk', 'Spinach']);
  assert.equal(items[1].unit, 'l');
  assert.equal(items[1].category, 'dairy');
});

let srv;
before(async () => { srv = await start(); });
after(async () => { await srv.close(); });

test('end to end: add items, plan, mark used, impact updates', async () => {
  const c = client(srv.base);
  await c('/api/auth/register', { method: 'POST', body: { email: 'e2e@test.co', password: 'longenoughpass' } });
  await c('/api/auth/profile', { method: 'PUT', body: { diet: 'vegetarian', allergens: ['dairy'], household: 2 } });
  for (const [name, d, cat] of [['Spinach', 1, 'produce'], ['Tomatoes', 2, 'produce'], ['Paneer', 1, 'dairy'], ['Chicken', 1, 'meat']]) {
    assert.equal((await c('/api/pantry', { method: 'POST', body: { name, quantity: 300, unit: 'g', category: cat, expires_on: future(d), cost: 80 } })).status, 201);
  }
  const plan = await c('/api/agent/plan', { method: 'POST', body: { days: 3 } });
  assert.equal(plan.status, 200);
  const txt = JSON.stringify(plan.json.plan).toLowerCase();
  assert.ok(!txt.includes('paneer') && !txt.includes('chicken'));
  assert.ok(plan.json.stats.coverage > 0);

  const list = (await c('/api/pantry')).json.items;
  const sp = list.find((i) => i.name === 'Spinach');
  assert.equal((await c(`/api/pantry/${sp.id}`, { method: 'PATCH', body: { status: 'used' } })).json.kind, 'rescued');
  const impact = (await c('/api/agent/impact')).json;
  assert.equal(impact.rescued_items, 1);
  assert.equal(impact.money_saved, 80);
  assert.ok((await c('/api/agent/metrics')).json.requests > 0);
});
