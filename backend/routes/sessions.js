const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function getBroadcast(req) {
  return req.app.get('broadcast') || (() => {});
}

// Start sesjon for et lag (deltager-flyt)
router.post('/start', async (req, res) => {
  try {
    const { team_id } = req.body;
    if (!team_id) return res.status(400).json({ error: 'team_id påkrevd' });

    const teamRes = await pool.query(`
      SELECT t.*, e.scenario_id, e.status AS event_status, s.time_limit_seconds, s.name AS scenario_name
      FROM teams t
      JOIN events e ON e.id = t.event_id
      LEFT JOIN scenarios s ON s.id = e.scenario_id
      WHERE t.id = $1
    `, [team_id]);

    if (teamRes.rows.length === 0) return res.status(404).json({ error: 'Lag ikke funnet' });
    const team = teamRes.rows[0];

    // Sjekk om sesjon allerede finnes
    const existing = await pool.query(
      `SELECT * FROM sessions WHERE team_id = $1 AND status = 'active' LIMIT 1`,
      [team_id]
    );
    if (existing.rows.length > 0) {
      return res.json(existing.rows[0]);
    }

    const { rows } = await pool.query(
      `INSERT INTO sessions (team_id, status, started_at, time_limit_seconds)
       VALUES ($1, 'active', NOW(), $2) RETURNING *`,
      [team_id, team.time_limit_seconds || 3600]
    );

    const session = { ...rows[0], team_name: team.name, team_code: team.code, team_color: team.color };
    getBroadcast(req)({ type: 'session_started', session, event_id: team.event_id });
    res.json(session);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Hent aktiv sesjon for et lag
router.get('/active/:team_id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*, t.name AS team_name, t.code AS team_code, t.color AS team_color, t.event_id
      FROM sessions s
      JOIN teams t ON t.id = s.team_id
      WHERE t.id = $1 AND s.status = 'active'
      ORDER BY s.started_at DESC LIMIT 1
    `, [req.params.team_id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Ingen aktiv sesjon' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Logg event
router.post('/:id/event', async (req, res) => {
  try {
    const { puzzle_index, event_type, payload } = req.body;
    const sessionId = req.params.id;

    await pool.query(
      `INSERT INTO puzzle_events (session_id, puzzle_index, event_type, payload)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, puzzle_index || 0, event_type, payload || {}]
    );

    if (event_type === 'puzzle_solved') {
      await pool.query(
        'UPDATE sessions SET current_puzzle = $1 WHERE id = $2',
        [(puzzle_index || 0) + 1, sessionId]
      );
    } else if (event_type === 'hint_used') {
      await pool.query(
        'UPDATE sessions SET hints_used = hints_used + 1 WHERE id = $1',
        [sessionId]
      );
    }

    const { rows } = await pool.query(`
      SELECT s.*, t.name AS team_name, t.code AS team_code, t.color AS team_color, t.event_id
      FROM sessions s JOIN teams t ON t.id = s.team_id
      WHERE s.id = $1
    `, [sessionId]);

    getBroadcast(req)({
      type: 'session_event',
      session: rows[0],
      event_id: rows[0]?.event_id,
      event: { puzzle_index, event_type, payload }
    });

    res.json({ success: true, session: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Avslutt sesjon
router.post('/:id/finish', async (req, res) => {
  try {
    const { completed } = req.body;
    const sessionId = req.params.id;

    const { rows } = await pool.query(`
      UPDATE sessions
      SET status = 'finished',
          finished_at = NOW(),
          completed = $1,
          duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER
      WHERE id = $2 RETURNING *
    `, [!!completed, sessionId]);

    const teamRes = await pool.query(
      'SELECT t.name, t.code, t.color, t.event_id FROM teams t WHERE t.id = $1',
      [rows[0].team_id]
    );
    const session = { ...rows[0], ...teamRes.rows[0] };

    getBroadcast(req)({ type: 'session_finished', session, event_id: session.event_id });
    res.json(session);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Hent alle aktive sesjoner for et event (gamemaster-bruk)
router.get('/event/:event_id/active', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*, t.name AS team_name, t.code AS team_code, t.color AS team_color, t.event_id
      FROM sessions s
      JOIN teams t ON t.id = s.team_id
      WHERE t.event_id = $1 AND s.status = 'active'
      ORDER BY s.started_at DESC
    `, [req.params.event_id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

module.exports = router;
