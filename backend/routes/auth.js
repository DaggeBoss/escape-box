const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { signToken } = require('../middleware/auth');

const router = express.Router();

router.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Brukernavn og passord påkrevd' });
    }

    const { rows } = await pool.query(
      'SELECT * FROM admins WHERE username = $1',
      [username]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Feil brukernavn eller passord' });
    }

    const admin = rows[0];
    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Feil brukernavn eller passord' });
    }

    const token = signToken({ id: admin.id, username: admin.username, role: 'admin' });
    res.json({ token, username: admin.username });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server feil' });
  }
});

module.exports = router;
