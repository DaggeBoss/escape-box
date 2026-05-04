require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');

const { initDatabase } = require('./db');
const authRoutes = require('./routes/auth');
const teamsRoutes = require('./routes/teams');
const sessionsRoutes = require('./routes/sessions');
const statsRoutes = require('./routes/stats');

const app = express();
const server = http.createServer(app);

// CORS - tillat frontend-domene (sett FRONTEND_URL i Railway)
const allowedOrigins = (process.env.FRONTEND_URL || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return cb(null, true);
    }
    cb(new Error('CORS blokkert: ' + origin));
  },
  credentials: true,
}));

app.use(express.json({ limit: '5mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'escape-box-backend', version: '1.0.0' });
});
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/teams', teamsRoutes);
app.use('/api/sessions', sessionsRoutes);
app.use('/api/stats', statsRoutes);

// WebSocket setup
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', (ws, req) => {
  clients.add(ws);
  console.log(`🔌 WS tilkoblet (totalt: ${clients.size})`);

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      // Klient kan sende ping/pong, eller subscribe til specific session
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (e) {
      console.error('WS message parse error:', e.message);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`🔌 WS frakoblet (totalt: ${clients.size})`);
  });

  ws.on('error', (err) => {
    console.error('WS error:', err.message);
    clients.delete(ws);
  });

  ws.send(JSON.stringify({ type: 'welcome', timestamp: Date.now() }));
});

// Broadcast til alle tilkoblede klienter
function broadcast(payload) {
  const json = JSON.stringify(payload);
  clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(json);
    }
  });
}
app.set('broadcast', broadcast);

// Heartbeat - drep døde forbindelser (Railway terminerer idle WS)
setInterval(() => {
  clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    }
  });
}, 30000);

// Start
const PORT = process.env.PORT || 3000;

initDatabase()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`🚀 Escape Box backend kjører på port ${PORT}`);
      console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
      console.log(`   CORS allowed: ${allowedOrigins.join(', ')}`);
    });
  })
  .catch((err) => {
    console.error('💥 Kunne ikke starte server:', err);
    process.exit(1);
  });
