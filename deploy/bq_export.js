'use strict';
/**
 * Batch export of impact events to BigQuery (live streaming is also available via BQ_STREAM=true).
 * Reads from whichever database is configured (Supabase or SQLite).
 * Privacy: user ids become salted SHA-256 pseudonyms; emails and notes never leave the app database.
 *
 * Usage: BQ_SALT=<random> node --env-file=.env deploy/bq_export.js
 * Requires the `bq` CLI authenticated to your project (gcloud auth login).
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const store = require('../src/store');

const dataset = process.env.BQ_DATASET || 'pantrypilot';
const table = process.env.BQ_TABLE || 'waste_events';
const salt = process.env.BQ_SALT;
if (!salt) { console.error('Set BQ_SALT to a random secret so pseudonyms are not reversible.'); process.exit(1); }
const pseudo = (id) => crypto.createHash('sha256').update(`${salt}:${id}`).digest('hex').slice(0, 16);

(async () => {
  const rows = await store.allEvents();
  const tmp = path.join(os.tmpdir(), `pp-events-${Date.now()}.ndjson`);
  const ts = (v) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? v : String(v).replace(' ', 'T') + 'Z').toISOString();
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify({ user: pseudo(r.user_id), item: r.item_name, category: r.category, kind: r.kind, cost: r.cost, co2_kg: r.co2_kg, ts: ts(r.created_at) })).join('\n'));
  const schema = 'user:STRING,item:STRING,category:STRING,kind:STRING,cost:FLOAT,co2_kg:FLOAT,ts:TIMESTAMP';
  execFileSync('bq', ['mk', '--dataset', '--force', dataset], { stdio: 'inherit' });
  execFileSync('bq', ['load', '--replace', '--source_format=NEWLINE_DELIMITED_JSON', `${dataset}.${table}`, tmp, schema], { stdio: 'inherit' });
  fs.unlinkSync(tmp);
  console.log(`Loaded ${rows.length} events into ${dataset}.${table} (source: ${store.name})`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
