const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { requireAuth, requireRole, canAccessOrg } = require('../middleware/auth');

const router = express.Router();

// List brukere — superadmin ser alle, org_admin ser sine egne
router.get('/', requireAuth, async (req, res) => {
  try {
    const { user } = req;
    let query, params;
    if (user.role === 'superadmin') {
      query = `
        SELECT u.id, u.email, u.name, u.role, u.active, u.created_at,
               u.organization_id, o.name AS organization_name
        FROM users u
        LEFT JOIN organizations o ON o.id = u.organization_id
        ORDER BY u.created_at DESC
      `;
      params = [];
    } else if (user.role === 'org_admin') {
      query = `
        SELECT id, email, name, role, active, created_at, organization_id
        FROM users
        WHERE organization_id = $1
        ORDER BY created_at DESC
      `;
      params = [user.organization_id];
    } else {
      return res.status(403).json({ error: 'Ikke tilgang' });
    }

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Opprett bruker — org_admin kan kun lage org_admin/gamemaster i sin egen bedrift
router.post('/', requireAuth, async (req, res) => {
  try {
    const { user } = req;
    const { email, name, password, role, organization_id } = req.body;

    if (!email?.trim() || !name?.trim() || !password || !role) {
      return res.status(400).json({ error: 'Epost, navn, passord og rolle påkrevd' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Passord må være minst 6 tegn' });
    }

    let targetOrgId = organization_id;

    if (user.role === 'superadmin') {
      // Superadmin kan opprette hvem som helst, men må gi org_id for ikke-superadmin
      if (role !== 'superadmin' && !targetOrgId) {
        return res.status(400).json({ error: 'organization_id påkrevd' });
      }
    } else if (user.role === 'org_admin') {
      // Kan kun opprette org_admin og gamemaster i egen bedrift
      if (!['org_admin', 'gamemaster'].includes(role)) {
        return res.status(403).json({ error: 'Kan ikke opprette denne rollen' });
      }
      targetOrgId = user.organization_id;
    } else {
      return res.status(403).json({ error: 'Ikke tilgang' });
    }

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (organization_id, email, password_hash, name, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, name, role, organization_id, created_at`,
      [targetOrgId, email.trim().toLowerCase(), hash, name.trim(), role]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'En bruker med denne eposten finnes allerede' });
    }
    res.status(500).json({ error: 'Server feil' });
  }
});

// Aktiver/deaktiver bruker
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { user } = req;
    const { active, name, role } = req.body;
    const targetId = req.params.id;

    // Hent målbruker
    const targetRes = await pool.query('SELECT * FROM users WHERE id = $1', [targetId]);
    if (targetRes.rows.length === 0) return res.status(404).json({ error: 'Bruker ikke funnet' });
    const target = targetRes.rows[0];

    // Sjekk tilgang
    if (user.role === 'org_admin' && target.organization_id !== user.organization_id) {
      return res.status(403).json({ error: 'Ikke tilgang' });
    }
    if (user.role !== 'superadmin' && user.role !== 'org_admin') {
      return res.status(403).json({ error: 'Ikke tilgang' });
    }

    const updates = [];
    const params = [];
    let i = 1;
    if (typeof active === 'boolean') { updates.push(`active = $${i++}`); params.push(active); }
    if (name?.trim()) { updates.push(`name = $${i++}`); params.push(name.trim()); }
    if (role && user.role === 'superadmin') { updates.push(`role = $${i++}`); params.push(role); }

    if (updates.length === 0) return res.status(400).json({ error: 'Ingen endringer' });

    params.push(targetId);
    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${i} RETURNING id, email, name, role, active`,
      params
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Slett bruker
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { user } = req;
    const targetId = req.params.id;

    const targetRes = await pool.query('SELECT * FROM users WHERE id = $1', [targetId]);
    if (targetRes.rows.length === 0) return res.json({ success: true });
    const target = targetRes.rows[0];

    if (user.role === 'org_admin' && target.organization_id !== user.organization_id) {
      return res.status(403).json({ error: 'Ikke tilgang' });
    }
    if (user.role !== 'superadmin' && user.role !== 'org_admin') {
      return res.status(403).json({ error: 'Ikke tilgang' });
    }
    if (target.id === user.id) {
      return res.status(400).json({ error: 'Kan ikke slette deg selv' });
    }

    await pool.query('DELETE FROM users WHERE id = $1', [targetId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

module.exports = router;
