'use strict';
// Production driver: Supabase (Postgres). Uses the SERVICE ROLE key, which bypasses row-level security, so it must
// only ever live on the server (Secret Manager). Every query below is scoped by user_id; RLS in supabase/schema.sql
// additionally denies the public anon key everything, as a second layer.
const config = require('../config');

function mk(client) {
  const must = ({ data, error }) => {
    if (error) {
      const e = new Error(error.message || 'Supabase error');
      e.code = error.code === '23505' ? 'DUPLICATE' : error.code;
      throw e;
    }
    return data;
  };
  const parseUser = (u) => (u ? { ...u, allergens: typeof u.allergens === 'string' ? JSON.parse(u.allergens) : u.allergens || [], locked_until: Number(u.locked_until) || 0, id: Number(u.id) } : null);
  const T = (t) => client.from(t);

  return {
    name: 'supabase',
    async ping() { must(await T('users').select('id').limit(1)); return true; },

    async createUser({ email, passwordHash = null, firebaseUid = null }) {
      return parseUser(must(await T('users').insert({ email, password_hash: passwordHash, firebase_uid: firebaseUid }).select().single()));
    },
    async getUserById(id) { return parseUser(must(await T('users').select('*').eq('id', id).maybeSingle())); },
    async getUserByEmail(email) { return parseUser(must(await T('users').select('*').eq('email', email).maybeSingle())); },
    async getUserByFirebaseUid(uid) { return parseUser(must(await T('users').select('*').eq('firebase_uid', uid).maybeSingle())); },
    async linkFirebaseUid(id, uid) { must(await T('users').update({ firebase_uid: uid }).eq('id', id)); },
    async setLoginState(id, failed, lockedUntil) { must(await T('users').update({ failed_logins: failed, locked_until: lockedUntil }).eq('id', id)); },
    async updateProfile(id, { diet, allergens, household }) { must(await T('users').update({ diet, allergens, household }).eq('id', id)); },
    async deleteUser(id) { must(await T('users').delete().eq('id', id)); }, // FK ON DELETE CASCADE clears everything else

    async listActive(userId) {
      return must(await T('pantry_items').select('id,name,quantity,unit,category,expires_on,cost').eq('user_id', userId).eq('status', 'active').order('expires_on', { ascending: true })) || [];
    },
    async countActive(userId) {
      const r = await T('pantry_items').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'active');
      must(r);
      return r.count || 0;
    },
    async insertItems(userId, items) {
      // One multi-row INSERT is a single atomic statement in Postgres.
      const rows = must(await T('pantry_items').insert(items.map((i) => ({ user_id: userId, name: i.name, quantity: i.quantity, unit: i.unit, category: i.category, expires_on: i.expires_on, cost: i.cost }))).select('id'));
      return rows.map((r) => Number(r.id));
    },
    async getActiveItem(userId, id) { return must(await T('pantry_items').select('*').eq('id', id).eq('user_id', userId).eq('status', 'active').maybeSingle()); },
    async resolveItem(userId, item, status, kind, co2) {
      // Atomic via a SQL function (see schema.sql) so an item can never be marked without its impact event.
      must(await client.rpc('resolve_item', { p_user: userId, p_item: item.id, p_status: status, p_kind: kind, p_co2: co2 }));
    },
    async deleteItem(userId, id) {
      const rows = must(await T('pantry_items').delete().eq('id', id).eq('user_id', userId).select('id'));
      return rows.length > 0;
    },

    async insertPlan(userId, p) {
      return Number(must(await T('plans').insert({ user_id: userId, mode: p.mode, json: p.plan, coverage: p.coverage, projected_co2_kg: p.co2, projected_money: p.money }).select('id').single()).id);
    },
    async listPlans(userId) {
      return must(await T('plans').select('id,mode,coverage,projected_co2_kg,projected_money,created_at').eq('user_id', userId).order('id', { ascending: false }).limit(10)) || [];
    },
    async impactEvents(userId) { return must(await T('waste_events').select('kind,cost,co2_kg,created_at').eq('user_id', userId).order('id', { ascending: true }).limit(5000)) || []; },

    async allEvents() {
      const out = [];
      for (let from = 0; ; from += 1000) {
        const page = must(await T('waste_events').select('user_id,item_name,category,kind,cost,co2_kg,created_at').order('id', { ascending: true }).range(from, from + 999)) || [];
        out.push(...page);
        if (page.length < 1000) return out;
      }
    },

    async exportAll(userId) {
      const [pantry, events, plans] = await Promise.all([
        T('pantry_items').select('name,quantity,unit,category,expires_on,cost,status,created_at').eq('user_id', userId),
        T('waste_events').select('item_name,category,kind,cost,co2_kg,created_at').eq('user_id', userId),
        T('plans').select('mode,json,coverage,created_at').eq('user_id', userId),
      ]);
      return { pantry: must(pantry) || [], events: must(events) || [], plans: must(plans) || [] };
    },

    async audit(userId, event, detail, ip) {
      must(await T('audit_log').insert({ user_id: userId ?? null, event, detail: detail ? String(detail).slice(0, 500) : null, ip: ip || null }));
    },
    async cacheGet(key, minCreatedAt) {
      const r = must(await T('llm_cache').select('value').eq('key', key).gte('created_at', minCreatedAt).maybeSingle());
      return r ? r.value : null;
    },
    async cacheSet(key, value) { must(await T('llm_cache').upsert({ key, value, created_at: Date.now() })); },
    async cachePrune(olderThan) { must(await T('llm_cache').delete().lt('created_at', olderThan)); },
    async incrementUsage(userId, day) { return Number(must(await client.rpc('increment_ai_usage', { p_user: userId, p_day: day }))); },
    async getUsage(userId, day) { return must(await T('ai_usage').select('calls').eq('user_id', userId).eq('day', day).maybeSingle())?.calls || 0; },
  };
}

function create(client) {
  if (!client) {
    const { createClient } = require('@supabase/supabase-js');
    client = createClient(config.supabase.url, config.supabase.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return mk(client);
}
module.exports = { create };
