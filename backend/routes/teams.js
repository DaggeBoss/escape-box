const express = require('express');
const { pool } = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Generer enkel kode (4 tegn, ingen forvirrende tegn)
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// List alle lag (admin)
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.*,
        COUNT(s.id) AS sessions_count,
        COUNT(s.id) FILTER (WHERE s.completed) AS completed_count
      FROM teams t
      LEFT JOIN sessions s ON s.team_id = t.id
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Opprett nytt lag (admin)
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Navn påkrevd' });

    let code, attempts = 0;
    while (attempts < 10) {
      code = generateCode();
      const exists = await pool.query('SELECT 1 FROM teams WHERE code = $1', [code]);
      if (exists.rows.length === 0) break;
      attempts++;
    }

    const { rows } = await pool.query(
      'INSERT INTO teams (name, code) VALUES ($1, $2) RETURNING *',
      [name.trim(), code]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Slett lag (admin)
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM teams WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Slå opp lag via kode (offentlig — for spillerne)
router.get('/code/:code', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, code FROM teams WHERE code = $1',
      [req.params.code.toUpperCase()]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Ugyldig kode' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

module.exports = router;
