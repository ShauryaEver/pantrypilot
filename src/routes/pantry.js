'use strict';
const express = require('express');
const { z } = require('zod');
const config = require('../config');
const store = require('../store');
const bigquery = require('../integrations/bigquery');
const { requireAuth, validate, agentLimiter } = require('../middleware/security');
const { itemInput, daysLeft, co2For } = require('../lib/domain');
const receipt = require('../agents/receipt');

const router = express.Router();
router.use(requireAuth);

const idParam = z.object({ id: z.coerce.number().int().positive() });
const statusInput = z.object({ status: z.enum(['used', 'wasted']) });
const textInput = z.object({ text: z.string().trim().min(3).max(6000) });
const imageInput = z.object({ mime: z.enum(['image/jpeg', 'image/png', 'image/webp']), data: z.string().min(100).max(6_000_000) });
const bulkInput = z.object({ items: z.array(itemInput).min(1).max(60) });

const MAGIC = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': [0x52, 0x49, 0x46, 0x46] };

router.get('/', async (req, res) => {
  const rows = await store.listActive(req.user.id);
  res.json({ items: rows.map((r) => ({ ...r, days_left: daysLeft(r.expires_on) })) });
});

async function insertMany(userId, items) {
  const count = await store.countActive(userId);
  if (count + items.length > config.maxPantryItems) return null;
  return store.insertItems(userId, items);
}

router.post('/', validate(itemInput), async (req, res) => {
  const ids = await insertMany(req.user.id, [req.valid]);
  if (!ids) return res.status(409).json({ error: `Pantry limit of ${config.maxPantryItems} items reached` });
  res.status(201).json({ id: ids[0] });
});

router.post('/bulk', validate(bulkInput), async (req, res) => {
  const ids = await insertMany(req.user.id, req.valid.items);
  if (!ids) return res.status(409).json({ error: `Pantry limit of ${config.maxPantryItems} items reached` });
  store.safeAudit(req.user.id, 'pantry_bulk_add', String(ids.length), req.ip);
  res.status(201).json({ added: ids.length });
});

// Mark used/wasted: logs an impact event (feeds analytics + live BigQuery stream).
router.patch('/:id', validate(idParam, 'params'), async (req, res) => {
  const parsed = statusInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const item = await store.getActiveItem(req.user.id, req.valid.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const { status } = parsed.data;
  const kind = status === 'wasted' ? 'wasted' : daysLeft(item.expires_on) <= 3 ? 'rescued' : 'used';
  const co2 = co2For(item);
  await store.resolveItem(req.user.id, item, status, kind, co2);
  bigquery.streamEvent(req.user.id, { item_name: item.name, category: item.category, kind, cost: item.cost, co2_kg: co2 }); // not awaited on purpose
  res.json({ ok: true, kind });
});

router.delete('/:id', validate(idParam, 'params'), async (req, res) => {
  if (!(await store.deleteItem(req.user.id, req.valid.id))) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.post('/parse-text', agentLimiter, validate(textInput), async (req, res) => {
  res.json(await receipt.parseText(req.valid.text, req.user.id));
});

// Image route: strict size, MIME allow-list and magic-byte verification before anything reaches the model.
router.post('/parse-image', agentLimiter, express.json({ limit: '6mb' }), (req, res, next) => {
  const parsed = imageInput.safeParse(req.body);
  if (!parsed.success || !/^[A-Za-z0-9+/=]+$/.test(parsed.data.data)) return res.status(400).json({ error: 'Invalid image payload' });
  const buf = Buffer.from(parsed.data.data, 'base64');
  if (buf.length > 4 * 1024 * 1024) return res.status(413).json({ error: 'Image larger than 4MB' });
  const magic = MAGIC[parsed.data.mime];
  if (!magic.every((b, i) => buf[i] === b)) return res.status(400).json({ error: 'File content does not match its type' });
  receipt.parseImage(parsed.data.data, parsed.data.mime, req.user.id).then((out) => res.json(out)).catch((e) => (e.status ? res.status(e.status).json({ error: e.message }) : next(e)));
});

module.exports = router;
