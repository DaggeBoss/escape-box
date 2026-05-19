const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

// ─── Default scenario_data-struktur ────────────────────────
// Erstatter det gamle koordinat/grid/anker-baserte systemet.
// Spillet drives nå av passord (4-sifret kode) som hver kan trigge
// poeng + kort + minispill + filer i en fiktiv server. Se README for
// full spesifikasjon.
const DEFAULT_SCENARIO_DATA = {
  passwords: [],
  cards: [],
  minigames: [],
  fictional_server: {
    name: 'Server',
    folders: [],
  },
  settings: {
    time_limit_enabled: true,
    show_score: true,
    require_consent: true,
    streetview_enabled: true,
  },
};

// Idempotente migrasjoner i individuelle try/catch (samme mønster som BME Portal)
async function initDatabase() {
  console.log('🔧 Initialiserer database...');

  // Organisations (bedrifter)
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(50) UNIQUE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('  ✓ organizations');
  } catch (e) { console.error('  ✗ organizations:', e.message); }

  // Users (alle admin-brukere — superadmin, org_admin, gamemaster)
  // 'participant'-rollen i constraint beholdes inntil videre for
  // bakoverkompatibilitet; nye deltagere lagres i participants-tabellen
  // (kommer i sesjon 4) — ikke i users.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
        email VARCHAR(150) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(100) NOT NULL,
        role VARCHAR(20) NOT NULL,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT users_role_check CHECK (role IN ('superadmin', 'org_admin', 'gamemaster', 'participant'))
      )
    `);
    console.log('  ✓ users');
  } catch (e) { console.error('  ✗ users:', e.message); }

  // Scenarios (scenariobiblioteket — superadmin eier alle)
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scenarios (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        time_limit_seconds INTEGER DEFAULT 3600,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('  ✓ scenarios');
  } catch (e) { console.error('  ✗ scenarios:', e.message); }

  // Utvid scenarios med scenario_data (JSONB med passord/kort/minispill/server)
  try {
    await pool.query(`
      ALTER TABLE scenarios
      ADD COLUMN IF NOT EXISTS scenario_data JSONB
      DEFAULT '${JSON.stringify(DEFAULT_SCENARIO_DATA)}'::jsonb
    `);
    console.log('  ✓ scenarios.scenario_data');
  } catch (e) { console.error('  ✗ scenarios alter:', e.message); }

  // Migrasjon: konverter gamle scenario_data (koordinat-basert) til nytt
  // skjema. Vi sjekker etter scenarios som har 'coordinates'-felt (gammel
  // struktur) og setter dem til ny default. Eksisterende data går tapt —
  // dette er avtalt i sesjon 1-planleggingen.
  try {
    const { rows } = await pool.query(`
      SELECT id, scenario_data FROM scenarios
      WHERE scenario_data ? 'coordinates'
         OR scenario_data ? 'grid'
         OR scenario_data ? 'cards_template'
         OR NOT (scenario_data ? 'passwords')
    `);
    if (rows.length > 0) {
      console.log(`  ⟳ Migrerer ${rows.length} scenario(er) til nytt skjema...`);
      for (const row of rows) {
        // Bevar evt. eksisterende settings hvis kompatible
        const oldSettings = row.scenario_data?.settings || {};
        const newData = {
          ...DEFAULT_SCENARIO_DATA,
          settings: {
            ...DEFAULT_SCENARIO_DATA.settings,
            // Bare overfør innstillinger som finnes i nytt skjema
            time_limit_enabled: oldSettings.time_limit_enabled !== false,
            show_score: oldSettings.show_score !== false,
          },
        };
        await pool.query(
          'UPDATE scenarios SET scenario_data = $1 WHERE id = $2',
          [JSON.stringify(newData), row.id]
        );
      }
      console.log(`  ✓ ${rows.length} scenario(er) migrert`);
    }
  } catch (e) { console.error('  ✗ scenario-migrasjon:', e.message); }

  // Events (en bedrift kjører et event basert på et scenario)
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
        scenario_id INTEGER REFERENCES scenarios(id) ON DELETE SET NULL,
        name VARCHAR(150) NOT NULL,
        code VARCHAR(10) UNIQUE NOT NULL,
        scheduled_at TIMESTAMPTZ,
        status VARCHAR(20) DEFAULT 'planned',
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT events_status_check CHECK (status IN ('planned', 'live', 'finished', 'cancelled'))
      )
    `);
    console.log('  ✓ events');
  } catch (e) { console.error('  ✗ events:', e.message); }

  // Teams (lag som tilhører et event)
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        code VARCHAR(10) NOT NULL,
        pin VARCHAR(10) NOT NULL,
        color VARCHAR(20) DEFAULT '#ff4444',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(event_id, code)
      )
    `);
    console.log('  ✓ teams');
  } catch (e) { console.error('  ✗ teams:', e.message); }

  // Sessions (selve spilløkten)
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        status VARCHAR(20) DEFAULT 'pending',
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        duration_seconds INTEGER,
        time_limit_seconds INTEGER DEFAULT 3600,
        completed BOOLEAN DEFAULT FALSE,
        hints_used INTEGER DEFAULT 0,
        current_puzzle INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT sessions_status_check CHECK (status IN ('pending', 'active', 'finished', 'cancelled'))
      )
    `);
    console.log('  ✓ sessions');
  } catch (e) { console.error('  ✗ sessions:', e.message); }

  // Puzzle events (logg over alt som skjer i en sesjon)
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS puzzle_events (
        id SERIAL PRIMARY KEY,
        session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
        puzzle_index INTEGER NOT NULL,
        event_type VARCHAR(30) NOT NULL,
        payload JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('  ✓ puzzle_events');
  } catch (e) { console.error('  ✗ puzzle_events:', e.message); }

  // Indekser for ytelse
  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_org ON events(organization_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_status ON events(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_teams_event ON teams(event_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_team ON sessions(team_id)`);
    console.log('  ✓ indekser');
  } catch (e) { console.error('  ✗ indekser:', e.message); }

  // Seed: opprett superadmin hvis ingen finnes
  try {
    const { rows } = await pool.query(`SELECT COUNT(*) FROM users WHERE role = 'superadmin'`);
    if (parseInt(rows[0].count, 10) === 0) {
      const defaultEmail = process.env.SUPERADMIN_EMAIL || '[email protected]';
      const defaultPass = process.env.SUPERADMIN_PASSWORD || 'changeme123';
      const hash = await bcrypt.hash(defaultPass, 10);
      await pool.query(
        `INSERT INTO users (email, password_hash, name, role)
         VALUES ($1, $2, $3, 'superadmin')`,
        [defaultEmail, hash, 'Superadmin']
      );
      console.log(`  ✓ Superadmin opprettet: ${defaultEmail} / ${defaultPass}`);
      console.log('  ⚠️  ENDRE PASSORD UMIDDELBART I PRODUKSJON');
    }
  } catch (e) { console.error('  ✗ superadmin seed:', e.message); }

  console.log('✅ Database klar');
}

module.exports = { pool, initDatabase, DEFAULT_SCENARIO_DATA };
