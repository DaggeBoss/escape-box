const express = require('express');
const { pool, DEFAULT_SCENARIO_DATA } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Sørg for at scenario_data har alle påkrevde felter (defensiv normalisering
// — kjøres på alle hent-respons slik at frontend aldri ser undefined-felter
// selv om DB-raden ble lagret før migrasjonen til nytt skjema)
function normalizeScenarioData(sd) {
  if (!sd || typeof sd !== 'object') return { ...DEFAULT_SCENARIO_DATA };
  return {
    passwords: Array.isArray(sd.passwords) ? sd.passwords : [],
    cards: Array.isArray(sd.cards) ? sd.cards : [],
    minigames: Array.isArray(sd.minigames) ? sd.minigames : [],
    fictional_server: sd.fictional_server && typeof sd.fictional_server === 'object'
      ? { name: sd.fictional_server.name || 'Server', folders: Array.isArray(sd.fictional_server.folders) ? sd.fictional_server.folders : [] }
      : { name: 'Server', folders: [] },
    settings: { ...DEFAULT_SCENARIO_DATA.settings, ...(sd.settings || {}) },
  };
}

// List scenarier — alle innloggede kan se aktive
router.get('/', requireAuth, async (req, res) => {
  try {
    const { user } = req;
    const showInactive = user.role === 'superadmin' && req.query.all === '1';

    const where = showInactive ? '' : 'WHERE active = TRUE';
    // passwords_count erstatter coord_count fra det gamle skjemaet —
    // tallet vises i scenario-listen som indikasjon på "innhold".
    const { rows } = await pool.query(`
      SELECT id, name, description, time_limit_seconds, active, created_at,
             COALESCE(jsonb_array_length(scenario_data->'passwords'), 0) AS passwords_count
      FROM scenarios ${where}
      ORDER BY created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Hent ett scenario (med full scenario_data)
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM scenarios WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Scenario ikke funnet' });
    const sc = rows[0];
    sc.scenario_data = normalizeScenarioData(sc.scenario_data);
    res.json(sc);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Opprett scenario (kun superadmin)
router.post('/', requireRole('superadmin'), async (req, res) => {
  try {
    const { name, description, time_limit_seconds } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Navn påkrevd' });

    const defaultData = {
      ...DEFAULT_SCENARIO_DATA,
      settings: {
        ...DEFAULT_SCENARIO_DATA.settings,
        time_limit_enabled: !!time_limit_seconds,
      },
    };

    const { rows } = await pool.query(
      `INSERT INTO scenarios (name, description, time_limit_seconds, created_by_user_id, scenario_data)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name.trim(), description || null, time_limit_seconds || 3600, req.user.id, JSON.stringify(defaultData)]
    );
    rows[0].scenario_data = normalizeScenarioData(rows[0].scenario_data);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Oppdater scenario
router.patch('/:id', requireRole('superadmin'), async (req, res) => {
  try {
    const { name, description, time_limit_seconds, active, scenario_data } = req.body;
    const updates = [];
    const params = [];
    let i = 1;
    if (name?.trim()) { updates.push(`name = $${i++}`); params.push(name.trim()); }
    if (description !== undefined) { updates.push(`description = $${i++}`); params.push(description); }
    if (time_limit_seconds) { updates.push(`time_limit_seconds = $${i++}`); params.push(time_limit_seconds); }
    if (typeof active === 'boolean') { updates.push(`active = $${i++}`); params.push(active); }
    if (scenario_data) {
      if (typeof scenario_data !== 'object') {
        return res.status(400).json({ error: 'scenario_data må være et objekt' });
      }
      const normalized = normalizeScenarioData(scenario_data);
      updates.push(`scenario_data = $${i++}`);
      params.push(JSON.stringify(normalized));
    }

    if (updates.length === 0) return res.status(400).json({ error: 'Ingen endringer' });
    params.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE scenarios SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Scenario ikke funnet' });
    rows[0].scenario_data = normalizeScenarioData(rows[0].scenario_data);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

// Slett scenario
router.delete('/:id', requireRole('superadmin'), async (req, res) => {
  try {
    const used = await pool.query('SELECT 1 FROM events WHERE scenario_id = $1 LIMIT 1', [req.params.id]);
    if (used.rows.length > 0) {
      await pool.query('UPDATE scenarios SET active = FALSE WHERE id = $1', [req.params.id]);
      return res.json({ success: true, deactivated: true });
    }
    await pool.query('DELETE FROM scenarios WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server feil' });
  }
});

module.exports = router;
