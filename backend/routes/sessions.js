const express = require('express');
const { pool } = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Hjelper: hent broadcast-funksjon
function getBroadcast(req) {
  return req.app.get('broadcast') || (() => {});
}

// Start ny sesjon (offentlig - lag starter sitt spill)
router.post('/start', async (req, res) => {
  try {
    const { team_code, box_name, time_limit_seconds } = req.body;
    if (!team_code || !box_name) {
      return res.status(400).json({ error: 'team_code og box_name påkrevd' });
    }

    const teamRes = await pool.query(
      'SELECT * FROM teams WHERE code = $1',
      [team_code.toUpperCase()]
    );
    if (teamRes.rows.length === 0) {
      return res.status(404).json({ error: 'Ugyldig lagkode' });
    }
    const team = teamRes.rows[0];

    const { rows } = await pool.query(
      `INSERT INTO sessions (team_id, box_name, status, started_at, time_limit_seconds)
       VALUES ($1, $2, 'active', NOW(), $3)
       RETURNING *`,
      [team.id, box_name, time_limit_seconds || 3600]
    );

    const session = { ...rows[0], team_name: team.name, team_code: team.code };
    getBroadcast(req)({ type: 'session_started', session });
    res.json(session);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Hent aktiv sesjon for et lag
router.get('/active/:team_code', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*, t.name AS team_name, t.code AS team_code
      FROM sessions s
      JOIN teams t ON t.id = s.team_id
      WHERE t.code = $1 AND s.status = 'active'
      ORDER BY s.started_at DESC LIMIT 1
    `, [req.params.team_code.toUpperCase()]);
    if (rows.length === 0) return res.status(404).json({ error: 'Ingen aktiv sesjon' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Logg event under spill (puzzle løst, hint brukt, etc)
router.post('/:id/event', async (req, res) => {
  try {
    const { puzzle_index, event_type, payload } = req.body;
    const sessionId = req.params.id;

    await pool.query(
      `INSERT INTO puzzle_events (session_id, puzzle_index, event_type, payload)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, puzzle_index || 0, event_type, payload || {}]
    );

    // Oppdater current_puzzle / hints_used hvis relevant
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
      SELECT s.*, t.name AS team_name, t.code AS team_code
      FROM sessions s JOIN teams t ON t.id = s.team_id
      WHERE s.id = $1
    `, [sessionId]);

    getBroadcast(req)({
      type: 'session_event',
      session: rows[0],
      event: { puzzle_index, event_type, payload }
    });

    res.json({ success: true, session: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Avslutt sesjon (gjennomført eller stoppet)
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
      WHERE id = $2
      RETURNING *
    `, [!!completed, sessionId]);

    const teamRes = await pool.query('SELECT name, code FROM teams WHERE id = $1', [rows[0].team_id]);
    const session = { ...rows[0], team_name: teamRes.rows[0].name, team_code: teamRes.rows[0].code };

    getBroadcast(req)({ type: 'session_finished', session });
    res.json(session);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Admin: alle aktive sesjoner (live oversikt)
router.get('/active', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*, t.name AS team_name, t.code AS team_code
      FROM sessions s
      JOIN teams t ON t.id = s.team_id
      WHERE s.status = 'active'
      ORDER BY s.started_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Admin: alle sesjoner (historikk)
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*, t.name AS team_name, t.code AS team_code
      FROM sessions s
      JOIN teams t ON t.id = s.team_id
      ORDER BY s.started_at DESC LIMIT 200
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

module.exports = router;
