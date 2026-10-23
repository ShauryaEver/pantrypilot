'use strict';
// Local/dev driver. Same async interface as the Supabase driver (see src/store/index.js).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

function open() {
  if (config.dbPath !== ':memory:') fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  return init(new DatabaseSync(config.dbPath));
}

function init(db) {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  firebase_uid TEXT UNIQUE,
  diet TEXT NOT NULL DEFAULT 'none',
  allergens TEXT NOT NULL DEFAULT '[]',
  household INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS pantry_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, quantity REAL NOT NULL, unit TEXT NOT NULL, category TEXT NOT NULL,
  expires_on TEXT NOT NULL, cost REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','wasted')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pantry_user_status ON pantry_items(user_id, status, expires_on);
CREATE TABLE IF NOT EXISTS waste_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL, category TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('rescued','used','wasted')),
  cost REAL NOT NULL DEFAULT 0, co2_kg REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_events_user ON waste_events(user_id, created_at);
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL, json TEXT NOT NULL,
  coverage REAL NOT NULL DEFAULT 0, projected_co2_kg REAL NOT NULL DEFAULT 0, projected_money REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, event TEXT NOT NULL, detail TEXT, ip TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS llm_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
`);
  return db;
}

function create(existing) {
  const db = existing ? init(existing) : open();
  const parseUser = (u) => (u ? { ...u, allergens: JSON.parse(u.allergens) } : null);
  const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

  return {
    name: 'sqlite',
    async ping() { db.prepare('SELECT 1').get(); return true; },

    // ---- users ----
    async createUser({ email, passwordHash = null, firebaseUid = null }) {
      try {
        const info = db.prepare('INSERT INTO users (email, password_hash, firebase_uid) VALUES (?, ?, ?)').run(email, passwordHash, firebaseUid);
        return parseUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid));
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) { const err = new Error('duplicate'); err.code = 'DUPLICATE'; throw err; }
        throw e;
      }
    },
    async getUserById(id) { return parseUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)); },
    async getUserByEmail(email) { return parseUser(db.prepare('SELECT * FROM users WHERE email = ?').get(email)); },
    async getUserByFirebaseUid(uid) { return parseUser(db.prepare('SELECT * FROM users WHERE firebase_uid = ?').get(uid)); },
    async linkFirebaseUid(id, uid) { db.prepare('UPDATE users SET firebase_uid = ? WHERE id = ?').run(uid, id); },
    async setLoginState(id, failed, lockedUntil) { db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(failed, lockedUntil, id); },
    async updateProfile(id, { diet, allergens, household }) {
      db.prepare('UPDATE users SET diet = ?, allergens = ?, household = ? WHERE id = ?').run(diet, JSON.stringify(allergens), household, id);
    },
    async deleteUser(id) { db.prepare('DELETE FROM users WHERE id = ?').run(id); },

    // ---- pantry ----
    async listActive(userId) {
      return db.prepare("SELECT id, name, quantity, unit, category, expires_on, cost FROM pantry_items WHERE user_id = ? AND status = 'active' ORDER BY expires_on ASC").all(userId);
    },
    async countActive(userId) { return db.prepare("SELECT COUNT(*) c FROM pantry_items WHERE user_id = ? AND status = 'active'").get(userId).c; },
    async insertItems(userId, items) {
      const stmt = db.prepare('INSERT INTO pantry_items (user_id, name, quantity, unit, category, expires_on, cost) VALUES (?, ?, ?, ?, ?, ?, ?)');
      return tx(() => items.map((i) => Number(stmt.run(userId, i.name, i.quantity, i.unit, i.category, i.expires_on, i.cost).lastInsertRowid)));
    },
    async getActiveItem(userId, id) { return db.prepare("SELECT * FROM pantry_items WHERE id = ? AND user_id = ? AND status = 'active'").get(id, userId) || null; },
    async resolveItem(userId, item, status, kind, co2) {
      tx(() => {
        db.prepare('UPDATE pantry_items SET status = ? WHERE id = ?').run(status, item.id);
        db.prepare('INSERT INTO waste_events (user_id, item_name, category, kind, cost, co2_kg) VALUES (?, ?, ?, ?, ?, ?)').run(userId, item.name, item.category, kind, item.cost, co2);
      });
    },
    async deleteItem(userId, id) { return db.prepare('DELETE FROM pantry_items WHERE id = ? AND user_id = ?').run(id, userId).changes > 0; },

    // ---- plans & impact ----
    async insertPlan(userId, p) {
      const info = db.prepare('INSERT INTO plans (user_id, mode, json, coverage, projected_co2_kg, projected_money) VALUES (?, ?, ?, ?, ?, ?)')
        .run(userId, p.mode, JSON.stringify(p.plan), p.coverage, p.co2, p.money);
      return Number(info.lastInsertRowid);
    },
    async listPlans(userId) {
      return db.prepare('SELECT id, mode, coverage, projected_co2_kg, projected_money, created_at FROM plans WHERE user_id = ? ORDER BY id DESC LIMIT 10').all(userId);
    },
    async impactEvents(userId) { return db.prepare('SELECT kind, cost, co2_kg, created_at FROM waste_events WHERE user_id = ? ORDER BY id').all(userId); },

    /** All events across users (batch analytics export only). */
    async allEvents() { return db.prepare('SELECT user_id, item_name, category, kind, cost, co2_kg, created_at FROM waste_events ORDER BY id').all(); },

    // ---- export (data portability) ----
    async exportAll(userId) {
      return {
        pantry: db.prepare('SELECT name, quantity, unit, category, expires_on, cost, status, created_at FROM pantry_items WHERE user_id = ?').all(userId),
        events: db.prepare('SELECT item_name, category, kind, cost, co2_kg, created_at FROM waste_events WHERE user_id = ?').all(userId),
        plans: db.prepare('SELECT mode, json, coverage, created_at FROM plans WHERE user_id = ?').all(userId).map((p) => ({ ...p, json: JSON.parse(p.json) })),
      };
    },

    // ---- audit, cache, AI usage ----
    async audit(userId, event, detail, ip) {
      db.prepare('INSERT INTO audit_log (user_id, event, detail, ip) VALUES (?, ?, ?, ?)').run(userId ?? null, event, detail ? String(detail).slice(0, 500) : null, ip || null);
    },
    async cacheGet(key, minCreatedAt) {
      const r = db.prepare('SELECT value FROM llm_cache WHERE key = ? AND created_at >= ?').get(key, minCreatedAt);
      return r ? JSON.parse(r.value) : null;
    },
    async cacheSet(key, value) { db.prepare('INSERT OR REPLACE INTO llm_cache (key, value, created_at) VALUES (?, ?, ?)').run(key, JSON.stringify(value), Date.now()); },
    async cachePrune(olderThan) { db.prepare('DELETE FROM llm_cache WHERE created_at < ?').run(olderThan); },
    /** Atomically increments today's AI call counter and returns the new count. */
    async incrementUsage(userId, day) {
      return tx(() => {
        db.prepare('INSERT INTO ai_usage (user_id, day, calls) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET calls = calls + 1').run(userId, day);
        return db.prepare('SELECT calls FROM ai_usage WHERE user_id = ? AND day = ?').get(userId, day).calls;
      });
    },
    async getUsage(userId, day) { return db.prepare('SELECT calls FROM ai_usage WHERE user_id = ? AND day = ?').get(userId, day)?.calls || 0; },
  };
}

module.exports = { create };
