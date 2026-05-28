const express = require('express');
const { pool, DEFAULT_CONCEPT_CONFIG } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { slugify } = require('../middleware/helpers');

const router = express.Router();

// Lag en unik key fra navn (escape_box-stil). Faller tilbake til 'konsept'.
async function uniqueKey(name) {
  let base = slugify(name || '').replace(/-/g, '_') || 'konsept';
  base = base.slice(0, 40);
  let key = base;
  let n = 1;
  while (true) {
    const exists = await pool.query('SELECT 1 FROM concepts WHERE key = $1', [key]);
    if (exists.rows.length === 0) return key;
    key = `${base}_${n++}`;
  }
}

// ─── List konsepter ─────────────────────────────────────────
// Superadmin ser alle (?all=1 for inaktive). Andre roller ser kun
// konsepter bedriften har en aktiv lisens på, med lisens-info påhengt.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { user } = req;

    if (user.role === 'superadmin') {
      const showInactive = req.query.all === '1';
      const where = showInactive ? '' : 'WHERE active = TRUE';
      const { rows } = await pool.query(`
        SELECT id, key, name, description, time_limit_seconds, active, created_at,
               COALESCE(jsonb_array_length(config->'passwords'), 0) AS passwords_count
        FROM concepts ${where}
        ORDER BY created_at DESC
      `);
      return res.json(rows);
    }

    // Org-admin / gamemaster: kun konsepter med aktiv lisens i egen bedrift
    const { rows } = await pool.query(`
      SELECT c.id, c.key, c.name, c.description, c.time_limit_seconds, c.active, c.created_at,
             COALESCE(jsonb_array_length(c.config->'passwords'), 0) AS passwords_count,
             ca.license_type,
             ca.credits_remaining,
             (ca.license_type = 'free') AS unlimited
      FROM concepts c
      JOIN concept_access ca ON ca.concept_id = c.id
      WHERE ca.organization_id = $1 AND ca.active = TRUE AND c.active = TRUE
      ORDER BY c.name ASC
    `, [user.organization_id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// ─── Hent ett konsept (med full config) ─────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { user } = req;
    const { rows } = await pool.query('SELECT * FROM concepts WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Konsept ikke funnet' });

    if (user.role !== 'superadmin') {
      const acc = await pool.query(
        `SELECT 1 FROM concept_access WHERE organization_id = $1 AND concept_id = $2 AND active = TRUE`,
        [user.organization_id, req.params.id]
      );
      if (acc.rows.length === 0) return res.status(403).json({ error: 'Ingen tilgang til dette konseptet' });
    }

    const c = rows[0];
    // MIDLERTIDIG alias for dagens frontend (fjernes i frontend-sesjonen)
    c.scenario_data = c.config;
    res.json(c);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// ─── Opprett konsept (kun superadmin) ───────────────────────
router.post('/', requireRole('superadmin'), async (req, res) => {
  try {
    const { name, description, time_limit_seconds, key, config } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Navn påkrevd' });

    const finalKey = key?.trim() ? key.trim() : await uniqueKey(name);
    const finalConfig = config && typeof config === 'object' ? config : DEFAULT_CONCEPT_CONFIG;

    const { rows } = await pool.query(
      `INSERT INTO concepts (key, name, description, time_limit_seconds, created_by_user_id, config)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [finalKey, name.trim(), description || null, time_limit_seconds || 3600, req.user.id, JSON.stringify(finalConfig)]
    );
    rows[0].scenario_data = rows[0].config;
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') return res.status(409).json({ error: 'En konsept-key er allerede i bruk' });
    res.status(500).json({ error: 'Server feil' });
  }
});

// ─── Oppdater konsept (kun superadmin) ──────────────────────
router.patch('/:id', requireRole('superadmin'), async (req, res) => {
  try {
    const { name, description, time_limit_seconds, active, config, key } = req.body;
    const updates = [];
    const params = [];
    let i = 1;
    if (name?.trim()) { updates.push(`name = $${i++}`); params.push(name.trim()); }
    if (key?.trim()) { updates.push(`key = $${i++}`); params.push(key.trim()); }
    if (description !== undefined) { updates.push(`description = $${i++}`); params.push(description); }
    if (time_limit_seconds) { updates.push(`time_limit_seconds = $${i++}`); params.push(time_limit_seconds); }
    if (typeof active === 'boolean') { updates.push(`active = $${i++}`); params.push(active); }
    if (config !== undefined) {
      if (typeof config !== 'object') return res.status(400).json({ error: 'config må være et objekt' });
      updates.push(`config = $${i++}`);
      params.push(JSON.stringify(config));
    }

    if (updates.length === 0) return res.status(400).json({ error: 'Ingen endringer' });
    params.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE concepts SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Konsept ikke funnet' });
    rows[0].scenario_data = rows[0].config;
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') return res.status(409).json({ error: 'En konsept-key er allerede i bruk' });
    res.status(500).json({ error: 'Server feil' });
  }
});

// ─── Slett konsept (kun superadmin) ─────────────────────────
router.delete('/:id', requireRole('superadmin'), async (req, res) => {
  try {
    const used = await pool.query('SELECT 1 FROM events WHERE concept_id = $1 LIMIT 1', [req.params.id]);
    if (used.rows.length > 0) {
      await pool.query('UPDATE concepts SET active = FALSE WHERE id = $1', [req.params.id]);
      return res.json({ success: true, deactivated: true });
    }
    await pool.query('DELETE FROM concepts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

module.exports = router;
