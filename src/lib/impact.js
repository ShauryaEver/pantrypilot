'use strict';
// Shared impact maths so SQLite and Supabase drivers give identical answers.
function isoWeek(dateStr) {
  let s = String(dateStr);
  if (!/(?:Z|[+-]\d\d:?\d\d)$/i.test(s)) s = s.replace(' ', 'T') + 'Z'; // SQLite timestamps carry no zone
  const d = new Date(s);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.floor((d.getTime() - start) / (7 * 864e5)) + 1;
  return `${d.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}

/** events: [{ kind, cost, co2_kg, created_at }] */
function summarize(events) {
  const by = {};
  for (const e of events) {
    const b = (by[e.kind] ||= { n: 0, cost: 0, co2: 0 });
    b.n++; b.cost += Number(e.cost) || 0; b.co2 += Number(e.co2_kg) || 0;
  }
  const g = (k, f) => by[k]?.[f] || 0;
  const saved = g('rescued', 'n') + g('used', 'n');
  const total = saved + g('wasted', 'n');
  const weeks = new Map();
  for (const e of events) {
    const w = isoWeek(e.created_at);
    const r = weeks.get(w) || { week: w, saved: 0, wasted: 0 };
    if (e.kind === 'wasted') r.wasted++; else r.saved++;
    weeks.set(w, r);
  }
  return {
    rescued_items: g('rescued', 'n'),
    used_items: g('used', 'n'),
    wasted_items: g('wasted', 'n'),
    money_saved: +(g('rescued', 'cost') + g('used', 'cost')).toFixed(2),
    money_wasted: +g('wasted', 'cost').toFixed(2),
    co2_saved_kg: +(g('rescued', 'co2') + g('used', 'co2')).toFixed(2),
    co2_wasted_kg: +g('wasted', 'co2').toFixed(2),
    waste_rate: total ? +(g('wasted', 'n') / total).toFixed(3) : 0,
    weekly: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)).slice(-8),
  };
}
module.exports = { summarize, isoWeek };
