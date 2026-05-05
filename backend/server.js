require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');

const { initDatabase } = require('./db');
const authRoutes = require('./routes/auth');
const orgRoutes = require('./routes/organizations');
const userRoutes = require('./routes/users');
const scenarioRoutes = require('./routes/scenarios');
const eventRoutes = require('./routes/events');
const sessionRoutes = require('./routes/sessions');

const app = express();
const server = http.createServer(app);

// CORS
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
  res.json({ status: 'ok', service: 'escape-box-backend', version: '2.0.0' });
});
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/organizations', orgRoutes);
app.use('/api/users', userRoutes);
app.use('/api/scenarios', scenarioRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/sessions', sessionRoutes);

// WebSocket
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`🔌 WS tilkoblet (totalt: ${clients.size})`);

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
      // Subscribe til event-id (for room-based broadcasting)
      if (data.type === 'subscribe' && data.event_id) {
        ws.subscribed_event = data.event_id;
        ws.send(JSON.stringify({ type: 'subscribed', event_id: data.event_id }));
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

// Broadcast: send til alle, ELLER kun til de som er subscribed til en gitt event
function broadcast(payload) {
  const json = JSON.stringify(payload);
  const targetEventId = payload.event_id;
  clients.forEach((ws) => {
    if (ws.readyState !== ws.OPEN) return;
    // Hvis broadcast har event_id, send kun til de som har subscribed til den
    if (targetEventId && ws.subscribed_event && ws.subscribed_event !== targetEventId) {
      return;
    }
    ws.send(json);
  });
}
app.set('broadcast', broadcast);

// Heartbeat
setInterval(() => {
  clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) ws.ping();
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
