const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { requireRole } = require('../middleware/auth');
const { slugify } = require('../middleware/helpers');

const router = express.Router();

// List alle bedrifter (superadmin)
router.get('/', requireRole('superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        o.*,
        COUNT(DISTINCT u.id) AS user_count,
        COUNT(DISTINCT e.id) AS event_count
      FROM organizations o
      LEFT JOIN users u ON u.organization_id = o.id
      LEFT JOIN events e ON e.organization_id = o.id
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Hent en bedrift med detaljer
router.get('/:id', requireRole('superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM organizations WHERE id = $1
    `, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Bedrift ikke funnet' });

    const org = rows[0];

    // Hent brukere i bedriften
    const usersRes = await pool.query(`
      SELECT id, email, name, role, active, created_at
      FROM users WHERE organization_id = $1
      ORDER BY created_at DESC
    `, [org.id]);
    org.users = usersRes.rows;

    res.json(org);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Opprett ny bedrift + admin-bruker
router.post('/', requireRole('superadmin'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, admin_email, admin_name, admin_password } = req.body;
    if (!name?.trim() || !admin_email?.trim() || !admin_name?.trim() || !admin_password) {
      return res.status(400).json({ error: 'Navn, admin-epost, admin-navn og passord påkrevd' });
    }
    if (admin_password.length < 6) {
      return res.status(400).json({ error: 'Passord må være minst 6 tegn' });
    }

    await client.query('BEGIN');

    // Generer unik slug
    let baseSlug = slugify(name);
    if (!baseSlug) baseSlug = 'bedrift';
    let slug = baseSlug;
    let counter = 1;
    while (true) {
      const exists = await client.query('SELECT 1 FROM organizations WHERE slug = $1', [slug]);
      if (exists.rows.length === 0) break;
      slug = `${baseSlug}-${counter++}`;
    }

    const orgRes = await client.query(
      'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING *',
      [name.trim(), slug]
    );
    const org = orgRes.rows[0];

    const hash = await bcrypt.hash(admin_password, 10);
    const userRes = await client.query(
      `INSERT INTO users (organization_id, email, password_hash, name, role)
       VALUES ($1, $2, $3, $4, 'org_admin')
       RETURNING id, email, name, role`,
      [org.id, admin_email.trim().toLowerCase(), hash, admin_name.trim()]
    );

    await client.query('COMMIT');
    res.json({ organization: org, admin: userRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'En bruker med denne eposten finnes allerede' });
    }
    res.status(500).json({ error: 'Server feil' });
  } finally {
    client.release();
  }
});

// Slett bedrift
router.delete('/:id', requireRole('superadmin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM organizations WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

module.exports = router;
