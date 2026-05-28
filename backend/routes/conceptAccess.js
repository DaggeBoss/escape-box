const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// All lisens-administrasjon er superadmin-only.

// ─── List lisenser ──────────────────────────────────────────
// Filtre: ?concept_id=  og/eller  ?organization_id=
router.get('/', requireRole('superadmin'), async (req, res) => {
  try {
    const filters = [];
    const params = [];
    let i = 1;
    if (req.query.concept_id) { filters.push(`ca.concept_id = $${i++}`); params.push(req.query.concept_id); }
    if (req.query.organization_id) { filters.push(`ca.organization_id = $${i++}`); params.push(req.query.organization_id); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const { rows } = await pool.query(`
      SELECT ca.*,
             o.name AS organization_name,
             c.name AS concept_name,
             c.key  AS concept_key
      FROM concept_access ca
      JOIN organizations o ON o.id = ca.organization_id
      JOIN concepts c ON c.id = ca.concept_id
      ${where}
      ORDER BY o.name ASC, c.name ASC
    `, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// ─── Gi / oppdater lisens ───────────────────────────────────
// body: { organization_id, concept_id, license_type: 'free'|'credits', credits }
// Upsert på (organization_id, concept_id). For 'credits' legges `credits`
// til saldoen (fungerer dermed også som påfyll). For 'free' ignoreres credits.
router.post('/', requireRole('superadmin'), async (req, res) => {
  try {
    const { organization_id, concept_id, license_type, credits } = req.body;
    if (!organization_id || !concept_id) {
      return res.status(400).json({ error: 'organization_id og concept_id påkrevd' });
    }
    const lt = license_type === 'credits' ? 'credits' : 'free';
    const addCredits = lt === 'credits' ? Math.max(0, parseInt(credits, 10) || 0) : 0;

    const { rows } = await pool.query(`
      INSERT INTO concept_access
        (organization_id, concept_id, license_type, credits_remaining, credits_granted, active, granted_by_user_id)
      VALUES ($1, $2, $3, $4, $4, TRUE, $5)
      ON CONFLICT (organization_id, concept_id) DO UPDATE SET
        license_type = EXCLUDED.license_type,
        credits_remaining = concept_access.credits_remaining + EXCLUDED.credits_remaining,
        credits_granted   = concept_access.credits_granted + EXCLUDED.credits_granted,
        active = TRUE,
        granted_by_user_id = EXCLUDED.granted_by_user_id,
        updated_at = NOW()
      RETURNING *
    `, [organization_id, concept_id, lt, addCredits, req.user.id]);

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23503') return res.status(404).json({ error: 'Ukjent bedrift eller konsept' });
    res.status(500).json({ error: 'Server feil' });
  }
});

// ─── Endre lisens / fyll på credits / aktiver-deaktiver ─────
// body: { license_type?, add_credits?, set_credits?, active? }
router.patch('/:id', requireRole('superadmin'), async (req, res) => {
  try {
    const { license_type, add_credits, set_credits, active } = req.body;
    const updates = [];
    const params = [];
    let i = 1;

    if (license_type === 'free' || license_type === 'credits') {
      updates.push(`license_type = $${i++}`); params.push(license_type);
    }
    if (typeof active === 'boolean') { updates.push(`active = $${i++}`); params.push(active); }
    if (set_credits !== undefined) {
      const v = Math.max(0, parseInt(set_credits, 10) || 0);
      updates.push(`credits_remaining = $${i++}`); params.push(v);
    } else if (add_credits !== undefined) {
      const v = Math.max(0, parseInt(add_credits, 10) || 0);
      updates.push(`credits_remaining = credits_remaining + $${i}`);
      updates.push(`credits_granted = credits_granted + $${i}`);
      params.push(v); i++;
    }

    if (updates.length === 0) return res.status(400).json({ error: 'Ingen endringer' });
    updates.push(`updated_at = NOW()`);
    params.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE concept_access SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Lisens ikke funnet' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// ─── Trekk tilbake lisens ───────────────────────────────────
router.delete('/:id', requireRole('superadmin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM concept_access WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

module.exports = router;
