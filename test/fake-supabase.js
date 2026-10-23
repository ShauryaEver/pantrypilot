'use strict';
// Minimal in-memory stand-in for @supabase/supabase-js, implementing only what src/store/supabase.js calls.
// It lets us run the SAME store test-suite against SQLite and the Supabase driver without a network.
function createFake() {
  const tables = {};
  const ids = {};
  const T = (n) => (tables[n] ||= []);
  const UNIQUE = { users: ['email', 'firebase_uid'] };
  const DEFAULTS = {
    users: { diet: 'none', allergens: [], household: 1, failed_logins: 0, locked_until: 0, password_hash: null, firebase_uid: null },
    pantry_items: { status: 'active', cost: 0 },
    waste_events: { cost: 0, co2_kg: 0 },
  };

  class Q {
    constructor(table) { this.table = table; this.op = 'select'; this.filters = []; this.payload = null; this.opts = {}; this.ord = null; this.lim = null; this.rng = null; this.single_ = null; this.returning = false; }
    select(cols, opts = {}) { if (this.op === 'select') this.opts = opts; else this.returning = true; return this; }
    insert(p) { this.op = 'insert'; this.payload = p; return this; }
    update(p) { this.op = 'update'; this.payload = p; return this; }
    delete() { this.op = 'delete'; return this; }
    upsert(p) { this.op = 'upsert'; this.payload = p; return this; }
    eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
    gte(c, v) { this.filters.push((r) => r[c] >= v); return this; }
    lt(c, v) { this.filters.push((r) => r[c] < v); return this; }
    order(c, { ascending = true } = {}) { this.ord = [c, ascending]; return this; }
    limit(n) { this.lim = n; return this; }
    range(a, b) { this.rng = [a, b]; return this; }
    maybeSingle() { this.single_ = 'maybe'; return this; }
    single() { this.single_ = 'one'; return this; }
    then(res, rej) { return Promise.resolve(this.run()).then(res, rej); }

    run() {
      const rows = T(this.table);
      const match = (r) => this.filters.every((f) => f(r));
      const err = (message, code) => ({ data: null, error: { message, code } });
      let out;
      if (this.op === 'insert' || this.op === 'upsert') {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload];
        const made = [];
        for (const p of list) {
          const row = { ...(DEFAULTS[this.table] || {}), ...JSON.parse(JSON.stringify(p)) };
          if (this.op === 'upsert' && row.key !== undefined) { const i = rows.findIndex((r) => r.key === row.key); if (i >= 0) { rows[i] = row; made.push(row); continue; } }
          for (const u of UNIQUE[this.table] || []) if (row[u] != null && rows.some((r) => r[u] === row[u])) return err('duplicate key value violates unique constraint', '23505');
          if (row.key === undefined) { ids[this.table] = (ids[this.table] || 0) + 1; row.id = ids[this.table]; }
          row.created_at ??= new Date().toISOString();
          rows.push(row); made.push(row);
        }
        out = made;
        if (!this.returning && this.single_ == null) return { data: null, error: null };
      } else if (this.op === 'update') {
        out = rows.filter(match);
        for (const r of out) Object.assign(r, this.payload);
        if (!this.returning) return { data: null, error: null };
      } else if (this.op === 'delete') {
        out = rows.filter(match);
        tables[this.table] = rows.filter((r) => !match(r));
        if (this.table === 'users') for (const t of ['pantry_items', 'waste_events', 'plans', 'ai_usage']) tables[t] = T(t).filter((r) => !out.some((u) => u.id === r.user_id));
        if (!this.returning) return { data: null, error: null };
      } else {
        out = rows.filter(match);
        if (this.opts.head) return { data: null, count: out.length, error: null };
      }
      if (this.ord) { const [c, asc] = this.ord; out = [...out].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1)); }
      if (this.rng) out = out.slice(this.rng[0], this.rng[1] + 1);
      if (this.lim != null) out = out.slice(0, this.lim);
      out = out.map((r) => JSON.parse(JSON.stringify(r)));
      if (this.single_ === 'maybe') return { data: out[0] || null, error: null };
      if (this.single_ === 'one') return out.length === 1 ? { data: out[0], error: null } : err('expected one row', 'PGRST116');
      return { data: out, count: out.length, error: null };
    }
  }

  const rpcs = {
    increment_ai_usage({ p_user, p_day }) {
      let r = T('ai_usage').find((x) => x.user_id === p_user && x.day === p_day);
      if (!r) { r = { user_id: p_user, day: p_day, calls: 0 }; T('ai_usage').push(r); }
      return { data: ++r.calls, error: null };
    },
    resolve_item({ p_user, p_item, p_status, p_kind, p_co2 }) {
      const it = T('pantry_items').find((r) => r.id === p_item && r.user_id === p_user && r.status === 'active');
      if (!it) return { data: null, error: { message: 'item not found', code: 'P0001' } };
      it.status = p_status;
      ids.waste_events = (ids.waste_events || 0) + 1;
      T('waste_events').push({ id: ids.waste_events, user_id: p_user, item_name: it.name, category: it.category, kind: p_kind, cost: it.cost, co2_kg: p_co2, created_at: new Date().toISOString() });
      return { data: null, error: null };
    },
  };

  return { from: (t) => new Q(t), rpc: async (name, args) => rpcs[name](args), _tables: tables };
}
module.exports = { createFake };
