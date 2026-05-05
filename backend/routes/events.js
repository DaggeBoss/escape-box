const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, canAccessOrg } = require('../middleware/auth');
const { generateCode, generatePin, getTeamColor } = require('../middleware/helpers');

const router = express.Router();

function getBroadcast(req) {
  return req.app.get('broadcast') || (() => {});
}

// List eventer — superadmin ser alle, andre ser bedriftens
router.get('/', requireAuth, async (req, res) => {
  try {
    const { user } = req;
    let query, params;

    const baseQuery = `
      SELECT e.*,
        o.name AS organization_name,
        s.name AS scenario_name,
        s.time_limit_seconds AS scenario_time_limit,
        u.name AS created_by_name,
        (SELECT COUNT(*) FROM teams WHERE event_id = e.id) AS team_count
      FROM events e
      LEFT JOIN organizations o ON o.id = e.organization_id
      LEFT JOIN scenarios s ON s.id = e.scenario_id
      LEFT JOIN users u ON u.id = e.created_by_user_id
    `;

    if (user.role === 'superadmin') {
      query = `${baseQuery} ORDER BY e.created_at DESC`;
      params = [];
    } else {
      query = `${baseQuery} WHERE e.organization_id = $1 ORDER BY e.created_at DESC`;
      params = [user.organization_id];
    }

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Hent ett event med lag
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const eventRes = await pool.query(`
      SELECT e.*,
        o.name AS organization_name,
        s.name AS scenario_name,
        s.description AS scenario_description,
        s.time_limit_seconds AS scenario_time_limit
      FROM events e
      LEFT JOIN organizations o ON o.id = e.organization_id
      LEFT JOIN scenarios s ON s.id = e.scenario_id
      WHERE e.id = $1
    `, [req.params.id]);

    if (eventRes.rows.length === 0) return res.status(404).json({ error: 'Event ikke funnet' });
    const ev = eventRes.rows[0];

    if (!canAccessOrg(req.user, ev.organization_id)) {
      return res.status(403).json({ error: 'Ikke tilgang' });
    }

    const teamsRes = await pool.query(`
      SELECT t.*,
        (SELECT id FROM sessions WHERE team_id = t.id ORDER BY started_at DESC LIMIT 1) AS latest_session_id,
        (SELECT status FROM sessions WHERE team_id = t.id ORDER BY started_at DESC LIMIT 1) AS session_status
      FROM teams t WHERE event_id = $1 ORDER BY id ASC
    `, [ev.id]);
    ev.teams = teamsRes.rows;

    res.json(ev);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Opprett event (org_admin og superadmin)
router.post('/', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { user } = req;
    if (!['superadmin', 'org_admin'].includes(user.role)) {
      return res.status(403).json({ error: 'Ikke tilgang' });
    }

    const { name, scenario_id, scheduled_at, organization_id, team_count, team_names } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Navn påkrevd' });
    if (!scenario_id) return res.status(400).json({ error: 'Scenario påkrevd' });

    const targetOrgId = user.role === 'superadmin'
      ? (organization_id || user.organization_id)
      : user.organization_id;
    if (!targetOrgId) return res.status(400).json({ error: 'organization_id påkrevd' });

    const numTeams = parseInt(team_count, 10) || 0;
    if (numTeams < 1 || numTeams > 50) {
      return res.status(400).json({ error: 'Antall lag må være 1-50' });
    }

    await client.query('BEGIN');

    // Generer unik event-kode
    let eventCode;
    while (true) {
      eventCode = generateCode(5);
      const exists = await client.query('SELECT 1 FROM events WHERE code = $1', [eventCode]);
      if (exists.rows.length === 0) break;
    }

    const evRes = await client.query(
      `INSERT INTO events (organization_id, scenario_id, name, code, scheduled_at, status, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, 'planned', $6) RETURNING *`,
      [targetOrgId, scenario_id, name.trim(), eventCode, scheduled_at || null, user.id]
    );
    const ev = evRes.rows[0];

    // Generer lag
    const teams = [];
    const usedCodes = new Set();
    for (let i = 0; i < numTeams; i++) {
      let code;
      while (true) {
        code = generateCode(4);
        if (!usedCodes.has(code)) {
          usedCodes.add(code);
          break;
        }
      }
      const teamName = team_names?.[i]?.trim() || `Lag ${i + 1}`;
      const pin = generatePin();
      const color = getTeamColor(i);
      const teamRes = await client.query(
        `INSERT INTO teams (event_id, name, code, pin, color)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [ev.id, teamName, code, pin, color]
      );
      teams.push(teamRes.rows[0]);
    }

    await client.query('COMMIT');
    ev.teams = teams;
    getBroadcast(req)({ type: 'event_created', event: ev });
    res.json(ev);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  } finally {
    client.release();
  }
});

// Oppdater event (status, navn, etc)
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { user } = req;
    const evRes = await pool.query('SELECT * FROM events WHERE id = $1', [req.params.id]);
    if (evRes.rows.length === 0) return res.status(404).json({ error: 'Event ikke funnet' });

    if (!canAccessOrg(user, evRes.rows[0].organization_id)) {
      return res.status(403).json({ error: 'Ikke tilgang' });
    }

    const { name, status, scheduled_at } = req.body;
    const updates = [];
    const params = [];
    let i = 1;
    if (name?.trim()) { updates.push(`name = $${i++}`); params.push(name.trim()); }
    if (status) { updates.push(`status = $${i++}`); params.push(status); }
    if (scheduled_at !== undefined) { updates.push(`scheduled_at = $${i++}`); params.push(scheduled_at); }

    if (updates.length === 0) return res.status(400).json({ error: 'Ingen endringer' });
    params.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE events SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
      params
    );
    getBroadcast(req)({ type: 'event_updated', event: rows[0] });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Slett event
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { user } = req;
    const evRes = await pool.query('SELECT organization_id FROM events WHERE id = $1', [req.params.id]);
    if (evRes.rows.length === 0) return res.json({ success: true });
    if (!canAccessOrg(user, evRes.rows[0].organization_id)) {
      return res.status(403).json({ error: 'Ikke tilgang' });
    }
    await pool.query('DELETE FROM events WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Hent et lag i et event (for QR-kode visning)
router.get('/:id/teams/:teamId', requireAuth, async (req, res) => {
  try {
    const { user } = req;
    const { rows } = await pool.query(`
      SELECT t.*, e.organization_id, e.code AS event_code, e.name AS event_name
      FROM teams t
      JOIN events e ON e.id = t.event_id
      WHERE t.id = $1 AND t.event_id = $2
    `, [req.params.teamId, req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Lag ikke funnet' });
    if (!canAccessOrg(user, rows[0].organization_id)) {
      return res.status(403).json({ error: 'Ikke tilgang' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Regenerer PIN for et lag
router.post('/:id/teams/:teamId/regenerate-pin', requireAuth, async (req, res) => {
  try {
    const { user } = req;
    const evRes = await pool.query('SELECT organization_id FROM events WHERE id = $1', [req.params.id]);
    if (evRes.rows.length === 0) return res.status(404).json({ error: 'Event ikke funnet' });
    if (!canAccessOrg(user, evRes.rows[0].organization_id)) {
      return res.status(403).json({ error: 'Ikke tilgang' });
    }

    const newPin = generatePin();
    const { rows } = await pool.query(
      `UPDATE teams SET pin = $1 WHERE id = $2 AND event_id = $3 RETURNING *`,
      [newPin, req.params.teamId, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Lag ikke funnet' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

module.exports = router;
