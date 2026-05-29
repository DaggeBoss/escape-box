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

// ─── Default config for Escape Box-konseptet ───────────────
// Hvert konsept har sin egen config-struktur (redigeres via sin egen
// skreddersydde bygger). Dette er default for escape_box. Andre konsepter
// får sin egen struktur når de bygges — concepts-tabellen lagrer config
// som rå JSONB og forutsetter ingen bestemt form.
const DEFAULT_CONCEPT_CONFIG = {
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

// Bakoverkompatibelt alias (eldre kode kan importere DEFAULT_SCENARIO_DATA)
const DEFAULT_SCENARIO_DATA = DEFAULT_CONCEPT_CONFIG;

// Idempotente migrasjoner i individuelle try/catch (samme mønster som BME Portal)
async function initDatabase() {
  console.log('🔧 Initialiserer database...');

  // ─── Organisasjoner (bedrifter) ─────────────────────────
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

  // ─── Brukere ────────────────────────────────────────────
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

  // ─── KONSEPTER ──────────────────────────────────────────
  // Erstatter scenarios. Ingen "type" — hvert konsept er sin egen enhet,
  // identifisert med en stabil `key` som peker til hardkodet motor + bygger.
  // Redigerbart innhold ligger i `config` (JSONB, fri form per konsept).

  // 1) Legacy: omdøp gammel scenarios-tabell -> concepts (kun hvis nødvendig)
  try {
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'scenarios')
           AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'concepts') THEN
          ALTER TABLE scenarios RENAME TO concepts;
        END IF;
      END $$;
    `);
  } catch (e) { console.error('  ✗ rename scenarios->concepts:', e.message); }

  // 2) Opprett concepts (fersk DB) — no-op hvis allerede omdøpt
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS concepts (
        id SERIAL PRIMARY KEY,
        key VARCHAR(50),
        name VARCHAR(100) NOT NULL,
        description TEXT,
        time_limit_seconds INTEGER DEFAULT 3600,
        config JSONB DEFAULT '{}'::jsonb,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('  ✓ concepts');
  } catch (e) { console.error('  ✗ concepts:', e.message); }

  // 3) Kolonne-normalisering: scenario_data -> config, samt sørg for key/config
  try {
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'concepts' AND column_name = 'scenario_data')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'concepts' AND column_name = 'config') THEN
          ALTER TABLE concepts RENAME COLUMN scenario_data TO config;
        END IF;
      END $$;
    `);
    await pool.query(`ALTER TABLE concepts ADD COLUMN IF NOT EXISTS config JSONB DEFAULT '{}'::jsonb`);
    await pool.query(`ALTER TABLE concepts ADD COLUMN IF NOT EXISTS key VARCHAR(50)`);
    // Backfill key for rader uten (migrerte scenarier), og unik indeks
    await pool.query(`UPDATE concepts SET key = 'concept_' || id WHERE key IS NULL OR key = ''`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_concepts_key ON concepts(key)`);
    console.log('  ✓ concepts.config/key');
  } catch (e) { console.error('  ✗ concepts kolonner:', e.message); }

  // ─── Concept access (lisens per bedrift × konsept) ──────
  // license_type: 'free'  = ubegrenset, ingen credit-trekk
  //               'credits' = trekker 1 credit når et event settes live
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS concept_access (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        license_type VARCHAR(20) NOT NULL DEFAULT 'free',
        credits_remaining INTEGER NOT NULL DEFAULT 0,
        credits_granted INTEGER NOT NULL DEFAULT 0,
        active BOOLEAN DEFAULT TRUE,
        granted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(organization_id, concept_id),
        CONSTRAINT concept_access_license_check CHECK (license_type IN ('free', 'credits'))
      )
    `);
    console.log('  ✓ concept_access');
  } catch (e) { console.error('  ✗ concept_access:', e.message); }

  // ─── Events ─────────────────────────────────────────────
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
        concept_id INTEGER REFERENCES concepts(id) ON DELETE SET NULL,
        name VARCHAR(150) NOT NULL,
        code VARCHAR(10) UNIQUE NOT NULL,
        scheduled_at TIMESTAMPTZ,
        status VARCHAR(20) DEFAULT 'planned',
        credits_charged BOOLEAN DEFAULT FALSE,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT events_status_check CHECK (status IN ('planned', 'live', 'finished', 'cancelled'))
      )
    `);
    // Legacy: omdøp scenario_id -> concept_id, og sørg for credits_charged
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'scenario_id')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'concept_id') THEN
          ALTER TABLE events RENAME COLUMN scenario_id TO concept_id;
        END IF;
      END $$;
    `);
    await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS credits_charged BOOLEAN DEFAULT FALSE`);
    console.log('  ✓ events');
  } catch (e) { console.error('  ✗ events:', e.message); }

  // ─── Teams ──────────────────────────────────────────────
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
    // Legacy: eldre baser kan mangle disse kolonnene (CREATE IF NOT EXISTS
    // legger ikke til kolonner på en tabell som allerede finnes). Uten FK
    // her, så migreringen aldri feiler på eksisterende rader.
    await pool.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS event_id INTEGER`);
    await pool.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS color VARCHAR(20) DEFAULT '#ff4444'`);
    console.log('  ✓ teams');
  } catch (e) { console.error('  ✗ teams:', e.message); }

  // ─── Sessions ───────────────────────────────────────────
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

  // ─── Puzzle events (hendelseslogg / milepæler) ──────────
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

  // ─── Indekser ───────────────────────────────────────────
  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_org ON events(organization_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_concept ON events(concept_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_status ON events(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_teams_event ON teams(event_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_team ON sessions(team_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_concept_access_org ON concept_access(organization_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_concept_access_concept ON concept_access(concept_id)`);
    console.log('  ✓ indekser');
  } catch (e) { console.error('  ✗ indekser:', e.message); }

  // ─── Seed: superadmin ───────────────────────────────────
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

  // ─── Seed: egen bedrift for superadmin + escape_box-konsept ──
  try {
    const sa = await pool.query(
      `SELECT id, organization_id FROM users WHERE role = 'superadmin' ORDER BY id ASC LIMIT 1`
    );
    if (sa.rows.length > 0) {
      const superId = sa.rows[0].id;

      // Egen bedrift (GameMaster) hvis superadmin mangler organisasjon
      if (!sa.rows[0].organization_id) {
        let org = await pool.query(`SELECT id FROM organizations WHERE slug = 'gamemaster' LIMIT 1`);
        if (org.rows.length === 0) {
          org = await pool.query(
            `INSERT INTO organizations (name, slug) VALUES ('GameMaster', 'gamemaster') RETURNING id`
          );
          console.log('  ✓ Bedrift "GameMaster" opprettet for superadmin');
        }
        await pool.query(`UPDATE users SET organization_id = $1 WHERE id = $2`, [org.rows[0].id, superId]);
      }

      // Escape Box som første konsept
      const ex = await pool.query(`SELECT id FROM concepts WHERE key = 'escape_box' LIMIT 1`);
      if (ex.rows.length === 0) {
        await pool.query(
          `INSERT INTO concepts (key, name, description, time_limit_seconds, config, created_by_user_id, active)
           VALUES ('escape_box', 'Escape Box', 'Passord-drevet escape room med kort og minispill', 3600, $1, $2, TRUE)`,
          [JSON.stringify(DEFAULT_CONCEPT_CONFIG), superId]
        );
        console.log('  ✓ Konsept "Escape Box" seedet');
      }
    }
  } catch (e) { console.error('  ✗ org/konsept seed:', e.message); }

  console.log('✅ Database klar');
}

module.exports = { pool, initDatabase, DEFAULT_CONCEPT_CONFIG, DEFAULT_SCENARIO_DATA };
