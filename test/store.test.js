'use strict';
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const sqliteDriver = require('../src/store/sqlite');
const supabaseDriver = require('../src/store/supabase');
const { createFake } = require('./fake-supabase');
const { summarize } = require('../src/lib/impact');

// The same behavioural contract is run against both drivers.
const drivers = {
  sqlite: () => sqliteDriver.create(new DatabaseSync(':memory:')),
  supabase: () => supabaseDriver.create(createFake()),
};
const item = (o = {}) => ({ name: 'Spinach', quantity: 200, unit: 'g', category: 'produce', expires_on: '2026-10-25', cost: 40, ...o });

for (const [name, make] of Object.entries(drivers)) {
  test(`[${name}] users: create, lookup, duplicate, login state, profile, cascade delete`, async () => {
    const s = make();
    const u = await s.createUser({ email: 'a@x.co', passwordHash: 'h' });
    assert.equal(typeof u.id, 'number');
    assert.deepEqual(u.allergens, []);
    assert.equal((await s.getUserByEmail('a@x.co')).id, u.id);
    assert.equal(await s.getUserByEmail('nobody@x.co'), null);
    await assert.rejects(s.createUser({ email: 'a@x.co', passwordHash: 'h' }), (e) => e.code === 'DUPLICATE');

    await s.setLoginState(u.id, 3, 12345);
    const l = await s.getUserById(u.id);
    assert.equal(l.failed_logins, 3);
    assert.equal(l.locked_until, 12345);

    await s.updateProfile(u.id, { diet: 'vegan', allergens: ['soy'], household: 3 });
    const p = await s.getUserById(u.id);
    assert.deepEqual([p.diet, p.allergens, p.household], ['vegan', ['soy'], 3]);

    const g = await s.createUser({ email: 'g@x.co', firebaseUid: 'uid-1' });
    assert.equal(g.password_hash, null);
    assert.equal((await s.getUserByFirebaseUid('uid-1')).email, 'g@x.co');
    await s.linkFirebaseUid(u.id, 'uid-2');
    assert.equal((await s.getUserByFirebaseUid('uid-2')).id, u.id);

    await s.insertItems(u.id, [item()]);
    await s.deleteUser(u.id);
    assert.equal(await s.getUserById(u.id), null);
    assert.equal((await s.exportAll(u.id)).pantry.length, 0);
  });

  test(`[${name}] pantry: scoped to the owner (IDOR), resolve logs an event atomically`, async () => {
    const s = make();
    const a = await s.createUser({ email: 'a@x.co', passwordHash: 'h' });
    const b = await s.createUser({ email: 'b@x.co', passwordHash: 'h' });
    const ids = await s.insertItems(a.id, [item(), item({ name: 'Milk', category: 'dairy', expires_on: '2026-10-24' })]);
    assert.equal(ids.length, 2);
    assert.equal(await s.countActive(a.id), 2);
    assert.equal((await s.listActive(a.id))[0].name, 'Milk'); // ordered by expiry
    assert.equal((await s.listActive(b.id)).length, 0);
    assert.equal(await s.getActiveItem(b.id, ids[0]), null);
    assert.equal(await s.deleteItem(b.id, ids[0]), false);

    const it = await s.getActiveItem(a.id, ids[0]);
    await s.resolveItem(a.id, it, 'used', 'rescued', 0.1);
    assert.equal(await s.getActiveItem(a.id, ids[0]), null);
    const ev = await s.impactEvents(a.id);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].kind, 'rescued');
    assert.equal(await s.deleteItem(a.id, ids[1]), true);
  });

  test(`[${name}] plans, audit, cache TTL, daily AI usage counter`, async () => {
    const s = make();
    const u = await s.createUser({ email: 'a@x.co', passwordHash: 'h' });
    const pid = await s.insertPlan(u.id, { mode: 'offline', plan: { meals: [] }, coverage: 1, co2: 0.5, money: 40 });
    assert.equal(typeof pid, 'number');
    assert.equal((await s.listPlans(u.id))[0].mode, 'offline');
    await s.audit(u.id, 'login', 'x', '1.1.1.1');

    await s.cacheSet('k', { a: 1 });
    assert.deepEqual(await s.cacheGet('k', Date.now() - 60000), { a: 1 });
    assert.equal(await s.cacheGet('k', Date.now() + 60000), null); // older than the TTL window
    await s.cachePrune(Date.now() + 60000);
    assert.equal(await s.cacheGet('k', 0), null);

    assert.equal(await s.incrementUsage(u.id, '2026-10-23'), 1);
    assert.equal(await s.incrementUsage(u.id, '2026-10-23'), 2);
    assert.equal(await s.incrementUsage(u.id, '2026-10-24'), 1);
    assert.equal(await s.getUsage(u.id, '2026-10-23'), 2);
    assert.equal(await s.getUsage(u.id, '2030-01-01'), 0);
  });

  test(`[${name}] batch export returns events across users`, async () => {
    const s = make();
    const a = await s.createUser({ email: 'a@x.co', passwordHash: 'h' });
    const [id] = await s.insertItems(a.id, [item()]);
    await s.resolveItem(a.id, await s.getActiveItem(a.id, id), 'wasted', 'wasted', 0.2);
    assert.equal((await s.allEvents()).length, 1);
    assert.equal((await s.exportAll(a.id)).events.length, 1);
  });
}

test('impact maths is shared and correct (both drivers feed the same function)', () => {
  const r = summarize([
    { kind: 'rescued', cost: 80, co2_kg: 1, created_at: '2026-10-20 10:00:00' },
    { kind: 'used', cost: 20, co2_kg: 0.5, created_at: '2026-10-21T10:00:00+00:00' },
    { kind: 'wasted', cost: 10, co2_kg: 2, created_at: '2026-10-21T11:00:00.000Z' },
  ]);
  assert.equal(r.money_saved, 100);
  assert.equal(r.co2_wasted_kg, 2);
  assert.equal(r.waste_rate, 0.333);
  assert.equal(r.weekly.length, 1);
  assert.deepEqual([r.weekly[0].saved, r.weekly[0].wasted], [2, 1]);
});
