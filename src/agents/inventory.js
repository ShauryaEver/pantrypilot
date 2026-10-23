'use strict';
// Inventory agent: deterministic, auditable risk scoring. No LLM needed here — cheaper and exact.
const { daysLeft, co2For } = require('../lib/domain');

function assess(items, today) {
  const scored = items.map((it) => {
    const d = daysLeft(it.expires_on, today);
    const urgency = d < 0 ? 'expired' : d <= 1 ? 'critical' : d <= 3 ? 'soon' : d <= 7 ? 'watch' : 'ok';
    return { ...it, days_left: d, urgency, co2_kg: co2For(it) };
  });
  const expiring = scored.filter((i) => i.urgency === 'critical' || i.urgency === 'soon' || i.urgency === 'watch');
  expiring.sort((a, b) => a.days_left - b.days_left || b.cost - a.cost);
  return {
    all: scored,
    expired: scored.filter((i) => i.urgency === 'expired'),
    expiring,
  };
}

module.exports = { assess };
