# Escape Box - Frontend

Single-file HTML SPA for Escape Box-spillet. Spill-modus, leaderboard og admin i ett.

## Konfig

Åpne `index.html` og endre `API_URL` (rundt linje 290) til din Railway-URL etter at backend er deployet:

```js
const API_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : 'https://DIN-RAILWAY-APP.up.railway.app';
```

## Deploy til Netlify

1. **Push til GitHub**: eget repo for frontend
2. **Netlify → Add new site → Import from GitHub**
3. Build command: tom (ingen build trengs)
4. Publish directory: `.`
5. Deploy.

Site er nå live på `https://din-app.netlify.app`. Husk å legge til denne URL-en i backendens `FRONTEND_URL`-miljøvariabel (Railway).

## Lokalt

Bare åpne `index.html` direkte i nettleseren, eller kjør en mini-server:

```bash
python3 -m http.server 5173
# eller
npx serve .
```
