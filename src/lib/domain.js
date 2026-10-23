'use strict';
const { z } = require('zod');

const UNITS = ['g', 'kg', 'ml', 'l', 'pcs', 'pack'];
const CATEGORIES = ['produce', 'dairy', 'meat', 'seafood', 'grains', 'bakery', 'pantry', 'other'];
const DIETS = ['none', 'vegetarian', 'vegan'];
const ALLERGENS = ['peanut', 'tree_nut', 'dairy', 'egg', 'gluten', 'soy', 'fish', 'shellfish', 'sesame'];

// kg CO2e per kg of food (rounded literature averages; shown to users as estimates).
const CO2_PER_KG = { produce: 0.9, dairy: 3.0, meat: 15, seafood: 6, grains: 1.5, bakery: 1.3, pantry: 2.0, other: 2.0 };
const SHELF_LIFE_DAYS = { produce: 5, dairy: 7, meat: 3, seafood: 2, grains: 180, bakery: 4, pantry: 90, other: 30 };

const ALLERGEN_TERMS = {
  peanut: ['peanut', 'groundnut'],
  tree_nut: ['almond', 'walnut', 'cashew', 'pecan', 'pistachio', 'hazelnut', 'macadamia'],
  dairy: ['milk', 'cheese', 'butter', 'cream', 'yogurt', 'yoghurt', 'paneer', 'ghee', 'curd', 'whey'],
  egg: ['egg', 'mayonnaise', 'mayo'],
  gluten: ['wheat', 'flour', 'bread', 'pasta', 'noodle', 'roti', 'chapati', 'semolina', 'couscous', 'barley', 'soy sauce'],
  soy: ['soy', 'tofu', 'tempeh', 'edamame', 'miso'],
  fish: ['fish', 'salmon', 'tuna', 'cod', 'anchovy', 'sardine'],
  shellfish: ['shrimp', 'prawn', 'crab', 'lobster', 'oyster', 'mussel', 'clam'],
  sesame: ['sesame', 'tahini'],
};
const MEAT_TERMS = ['chicken', 'beef', 'pork', 'lamb', 'mutton', 'bacon', 'ham', 'turkey', 'sausage', 'fish', 'salmon', 'tuna', 'shrimp', 'prawn', 'crab', 'meat', 'gelatin'];
const VEGAN_EXTRA_TERMS = ['milk', 'cheese', 'butter', 'cream', 'yogurt', 'yoghurt', 'paneer', 'ghee', 'curd', 'egg', 'honey', 'mayonnaise', 'whey'];

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)?\s*(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+|any\s+|the\s+)?(previous|prior|above)/i,
  /system\s+prompt/i,
  /developer\s+(message|mode)/i,
  /you\s+are\s+now\b/i,
  /<\/?\s*(system|assistant|user|instructions?)\s*>/i,
  /\b(jailbreak|DAN mode)\b/i,
];
const looksLikeInjection = (s) => INJECTION_PATTERNS.some((re) => re.test(s));

const foodName = z
  .string()
  .trim()
  .min(1, 'Name required')
  .max(60)
  .regex(/^[\p{L}\p{N} .,'&()\/-]+$/u, 'Name contains unsupported characters')
  .refine((s) => !looksLikeInjection(s), 'Name rejected by content filter');

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(s + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Invalid date')
  .refine((s) => {
    const y = Number(s.slice(0, 4));
    return y >= 2000 && y <= 2100;
  }, 'Date out of range');

const itemInput = z.object({
  name: foodName,
  quantity: z.number().positive().max(100000),
  unit: z.enum(UNITS),
  category: z.enum(CATEGORIES),
  expires_on: isoDate,
  cost: z.number().min(0).max(100000).default(0),
});

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}
function daysLeft(expiresOn, today = todayUTC()) {
  return Math.round((Date.parse(expiresOn + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
}
function addDays(days, from = todayUTC()) {
  const d = new Date(from + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function toKg(quantity, unit) {
  switch (unit) {
    case 'g': return quantity / 1000;
    case 'kg': return quantity;
    case 'ml': return quantity / 1000;
    case 'l': return quantity;
    case 'pcs': return quantity * 0.15;
    case 'pack': return quantity * 0.4;
    default: return 0;
  }
}
function co2For(item) {
  return +(toKg(item.quantity, item.unit) * (CO2_PER_KG[item.category] ?? 2)).toFixed(3);
}

// "peanut butter", "cocoa butter" etc. are not dairy; avoid false positives for vegan/dairy-free users.
const NON_DAIRY_BUTTER = /(?:peanut|almond|cashew|cocoa|shea|nut|seed|sunflower|apple)\s+butter/gi;
function containsTerm(text, term) {
  if (term === 'butter') text = text.replace(NON_DAIRY_BUTTER, ' ');
  return new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`, 'i').test(text);
}
/** Returns human-readable violations of the user's diet/allergen constraints. */
function constraintViolations(text, { diet, allergens }) {
  const out = [];
  for (const a of allergens || []) {
    for (const t of ALLERGEN_TERMS[a] || []) {
      if (containsTerm(text, t)) { out.push(`contains "${t}" (${a} allergen)`); break; }
    }
  }
  if (diet === 'vegetarian' || diet === 'vegan') {
    for (const t of MEAT_TERMS) if (containsTerm(text, t)) { out.push(`contains "${t}" (not ${diet})`); break; }
  }
  if (diet === 'vegan') {
    for (const t of VEGAN_EXTRA_TERMS) if (containsTerm(text, t)) { out.push(`contains "${t}" (not vegan)`); break; }
  }
  return out;
}

module.exports = {
  UNITS, CATEGORIES, DIETS, ALLERGENS, CO2_PER_KG, SHELF_LIFE_DAYS,
  foodName, isoDate, itemInput, looksLikeInjection,
  todayUTC, daysLeft, addDays, toKg, co2For, constraintViolations,
};
