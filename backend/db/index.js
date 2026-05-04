const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

// Idempotent migrasjoner i individuelle try/catch (samme mønster som BME Portal)
async function initDatabase() {
  console.log('🔧 Initialiserer database...');

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        code VARCHAR(20) UNIQUE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('  ✓ teams');
  } catch (e) { console.error('  ✗ teams:', e.message); }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        box_name VARCHAR(50) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        duration_seconds INTEGER,
        time_limit_seconds INTEGER DEFAULT 3600,
        completed BOOLEAN DEFAULT FALSE,
        hints_used INTEGER DEFAULT 0,
        current_puzzle INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('  ✓ sessions');
  } catch (e) { console.error('  ✗ sessions:', e.message); }

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

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('  ✓ admins');
  } catch (e) { console.error('  ✗ admins:', e.message); }

  // Seed default admin hvis ingen finnes
  try {
    const { rows } = await pool.query('SELECT COUNT(*) FROM admins');
    if (parseInt(rows[0].count, 10) === 0) {
      const bcrypt = require('bcryptjs');
      const defaultPass = process.env.DEFAULT_ADMIN_PASSWORD || 'changeme123';
      const hash = await bcrypt.hash(defaultPass, 10);
      await pool.query(
        'INSERT INTO admins (username, password_hash) VALUES ($1, $2)',
        ['admin', hash]
      );
      console.log(`  ✓ Default admin opprettet (admin / ${defaultPass})`);
      console.log('  ⚠️  ENDRE PASSORD UMIDDELBART I PRODUKSJON');
    }
  } catch (e) { console.error('  ✗ admin seed:', e.message); }

  console.log('✅ Database klar');
}

module.exports = { pool, initDatabase };
