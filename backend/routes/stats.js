const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Leaderboard - offentlig
router.get('/leaderboard', async (req, res) => {
  try {
    const box = req.query.box;
    const params = [];
    let where = `WHERE s.completed = TRUE`;
    if (box) {
      params.push(box);
      where += ` AND s.box_name = $${params.length}`;
    }

    const { rows } = await pool.query(`
      SELECT
        t.name AS team_name,
        s.box_name,
        s.duration_seconds,
        s.hints_used,
        s.finished_at
      FROM sessions s
      JOIN teams t ON t.id = s.team_id
      ${where}
      ORDER BY s.duration_seconds ASC, s.hints_used ASC
      LIMIT 50
    `, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Statistikk - offentlig oversikt
router.get('/stats', async (req, res) => {
  try {
    const { rows: total } = await pool.query(`
      SELECT
        COUNT(*) AS total_sessions,
        COUNT(*) FILTER (WHERE completed) AS completed_sessions,
        COUNT(*) FILTER (WHERE status = 'active') AS active_sessions,
        AVG(duration_seconds) FILTER (WHERE completed) AS avg_duration,
        AVG(hints_used) FILTER (WHERE completed) AS avg_hints
      FROM sessions
    `);

    const { rows: byBox } = await pool.query(`
      SELECT
        box_name,
        COUNT(*) AS sessions,
        COUNT(*) FILTER (WHERE completed) AS completed,
        AVG(duration_seconds) FILTER (WHERE completed) AS avg_duration
      FROM sessions
      GROUP BY box_name
      ORDER BY sessions DESC
    `);

    res.json({ overall: total[0], by_box: byBox });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

module.exports = router;
