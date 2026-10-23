'use strict';
// One async data interface, two drivers: Supabase (production) or SQLite (local/dev/tests).
const config = require('../config');

const store = config.useSupabase ? require('./supabase').create() : require('./sqlite').create();

/** Audit must never break a request. */
store.safeAudit = (userId, event, detail, ip) => store.audit(userId, event, detail, ip).catch(() => {});

module.exports = store;
