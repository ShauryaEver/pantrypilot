'use strict';
// Safety critic agent: deterministic guardrail between the model and the user.
// It verifies (1) diet/allergen safety, (2) grounding in the real pantry. The LLM never gets the last word.
const { constraintViolations } = require('../lib/domain');

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function matchPantryName(name, pantryNames) {
  const n = norm(name);
  return pantryNames.find((p) => {
    const q = norm(p);
    return q === n || q.includes(n) || n.includes(q);
  });
}

function review(plan, { pantryNames, profile }) {
  const violations = [];
  const safeMeals = [];
  let ungrounded = 0;

  for (const meal of plan.meals) {
    const text = [meal.title, ...meal.uses, ...meal.extras, ...meal.steps].join(' \n ');
    const problems = constraintViolations(text, profile);
    if (problems.length) {
      violations.push(...problems.map((p) => `Day ${meal.day} "${meal.title}" ${p}`));
      continue; // unsafe meals are never shown
    }
    // Grounding: names in "uses" must be real pantry items; otherwise demote to extras.
    const uses = [];
    const extras = [...meal.extras];
    for (const u of meal.uses) {
      const m = matchPantryName(u, pantryNames);
      if (m) uses.push(m);
      else { extras.push(u); ungrounded++; }
    }
    safeMeals.push({ ...meal, uses: [...new Set(uses)], extras: [...new Set(extras)] });
  }

  return { meals: safeMeals, violations, ungrounded };
}

module.exports = { review, matchPantryName };
