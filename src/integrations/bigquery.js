'use strict';
// Live streaming of impact events to BigQuery (in addition to the batch script in deploy/bq_export.js).
// Privacy: user ids are salted-hash pseudonyms; emails never leave the app database.
const config = require('../config');
const log = require('../lib/log');
const { pseudo } = require('./firebase');

const SCHEMA = [
  { name: 'user', type: 'STRING' }, { name: 'item', type: 'STRING' }, { name: 'category', type: 'STRING' },
  { name: 'kind', type: 'STRING' }, { name: 'cost', type: 'FLOAT' }, { name: 'co2_kg', type: 'FLOAT' }, { name: 'ts', type: 'TIMESTAMP' },
];
let tablePromise = null;
function getTable() {
  if (!tablePromise) {
    const { BigQuery } = require('@google-cloud/bigquery');
    const bq = new BigQuery({ projectId: config.bigquery.projectId || undefined });
    tablePromise = bq.dataset(config.bigquery.dataset).get({ autoCreate: true })
      .then(([ds]) => ds.table(config.bigquery.table).get({ autoCreate: true, schema: SCHEMA }))
      .then(([t]) => t)
      .catch((e) => { tablePromise = null; throw e; });
  }
  return tablePromise;
}

const enabled = () => config.bigquery.enabled;

async function streamEvent(userId, ev, tableOverride) {
  if (!enabled() && !tableOverride) return;
  try {
    const table = tableOverride || (await getTable());
    await table.insert([{ user: pseudo(userId), item: ev.item_name, category: ev.category, kind: ev.kind, cost: ev.cost, co2_kg: ev.co2_kg, ts: new Date().toISOString() }]);
  } catch (e) {
    log.warn('bigquery stream failed', { err: e.message }); // analytics must never break the user's request
  }
}

module.exports = { enabled, streamEvent };
