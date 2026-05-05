const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

// Login for users (superadmin, org_admin, gamemaster)
// Bruker email + passord
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Epost og passord påkrevd' });
    }

    const { rows } = await pool.query(
      `SELECT u.*, o.name AS organization_name
       FROM users u
       LEFT JOIN organizations o ON o.id = u.organization_id
       WHERE LOWER(u.email) = LOWER($1) AND u.active = TRUE`,
      [email.trim()]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Feil epost eller passord' });
    }

    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Feil epost eller passord' });
    }

    const token = signToken({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      organization_id: user.organization_id,
      organization_name: user.organization_name,
    });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organization_id: user.organization_id,
        organization_name: user.organization_name,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Login for deltager — via lagkode + PIN (ingen JWT, returnerer kun lag-info)
router.post('/team-login', async (req, res) => {
  try {
    const { event_code, team_code, pin } = req.body;
    if (!event_code || !team_code || !pin) {
      return res.status(400).json({ error: 'event_code, team_code og pin påkrevd' });
    }

    const { rows } = await pool.query(`
      SELECT t.*, e.name AS event_name, e.status AS event_status,
             e.code AS event_code, s.id AS scenario_id, s.name AS scenario_name,
             s.time_limit_seconds
      FROM teams t
      JOIN events e ON e.id = t.event_id
      LEFT JOIN scenarios s ON s.id = e.scenario_id
      WHERE LOWER(e.code) = LOWER($1) AND LOWER(t.code) = LOWER($2)
    `, [event_code.trim(), team_code.trim()]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Lag ikke funnet' });
    }

    const team = rows[0];
    if (team.pin !== pin.trim()) {
      return res.status(401).json({ error: 'Feil PIN' });
    }

    // Returner et "team token" (forenklet — ikke JWT, bare lag-id som klient sender med)
    res.json({
      team: {
        id: team.id,
        name: team.name,
        code: team.code,
        color: team.color,
        event_id: team.event_id,
        event_name: team.event_name,
        event_code: team.event_code,
        event_status: team.event_status,
        scenario_id: team.scenario_id,
        scenario_name: team.scenario_name,
        time_limit_seconds: team.time_limit_seconds,
      },
    });
  } catch (err) {
    console.error('Team login error:', err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Hent informasjon om innlogget bruker
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.name, u.role, u.organization_id, o.name AS organization_name
       FROM users u
       LEFT JOIN organizations o ON o.id = u.organization_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Bruker ikke funnet' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Bytt passord (kun innlogget bruker for seg selv)
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Passord påkrevd' });
    }
    if (new_password.length < 6) {
      return res.status(400).json({ error: 'Nytt passord må være minst 6 tegn' });
    }

    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Bruker ikke funnet' });

    const ok = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Feil nåværende passord' });

    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Oppdater profil (navn og/eller epost)
router.post('/update-profile', requireAuth, async (req, res) => {
  try {
    const { name, email } = req.body;
    const updates = [];
    const params = [];
    let i = 1;

    if (name?.trim()) {
      updates.push(`name = $${i++}`);
      params.push(name.trim());
    }
    if (email?.trim()) {
      const cleanEmail = email.trim().toLowerCase();
      // Sjekk at eposten ikke er tatt av en annen
      const exists = await pool.query(
        'SELECT 1 FROM users WHERE LOWER(email) = $1 AND id != $2',
        [cleanEmail, req.user.id]
      );
      if (exists.rows.length > 0) {
        return res.status(409).json({ error: 'Eposten er allerede i bruk' });
      }
      updates.push(`email = $${i++}`);
      params.push(cleanEmail);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'Ingen endringer' });
    params.push(req.user.id);

    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${i}
       RETURNING id, email, name, role, organization_id`,
      params
    );

    // Returner ny user-objekt og signer nytt token (slik at klient kan oppdatere)
    const user = rows[0];
    const orgRes = user.organization_id
      ? await pool.query('SELECT name FROM organizations WHERE id = $1', [user.organization_id])
      : { rows: [] };
    user.organization_name = orgRes.rows[0]?.name || null;

    const token = signToken({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      organization_id: user.organization_id,
      organization_name: user.organization_name,
    });

    res.json({ user, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

module.exports = router;
