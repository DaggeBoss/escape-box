# Escape Box - Backend

Express + PostgreSQL + WebSocket backend for Escape Box-spillet.

## Lokal utvikling

```bash
npm install
cp .env.example .env
# Fyll inn DATABASE_URL etc.
npm run dev
```

## Deploy til Railway

1. **Push til GitHub**: `git init && git add . && git commit -m "init" && git push`
2. **Railway → New Project → Deploy from GitHub repo**
3. **Legg til Postgres**: Railway → New → Database → PostgreSQL (DATABASE_URL settes automatisk)
4. **Sett miljøvariabler** under Variables:
   - `JWT_SECRET` — tilfeldig lang streng
   - `FRONTEND_URL` — Netlify-URL (f.eks. `https://escape-box.netlify.app`)
   - `DEFAULT_ADMIN_PASSWORD` — kun brukt første gang
5. **Generate Domain** under Settings → Networking
6. Backend er nå tilgjengelig på `https://din-app.up.railway.app`

## Endepunkter

### Offentlig
- `POST /api/auth/admin/login` — admin login
- `GET  /api/teams/code/:code` — slå opp lag via kode
- `POST /api/sessions/start` — start sesjon
- `GET  /api/sessions/active/:team_code` — hent aktiv sesjon
- `POST /api/sessions/:id/event` — logg event
- `POST /api/sessions/:id/finish` — avslutt sesjon
- `GET  /api/stats/leaderboard` — leaderboard
- `GET  /api/stats/stats` — statistikk
- `WS   /ws` — sanntidsoppdateringer

### Admin (krever Bearer token)
- `GET    /api/teams` — alle lag
- `POST   /api/teams` — opprett lag
- `DELETE /api/teams/:id` — slett lag
- `GET    /api/sessions` — alle sesjoner
- `GET    /api/sessions/active` — aktive sesjoner

## WebSocket-meldinger

Server → klient:
- `welcome` — ved tilkobling
- `session_started` — nytt spill startet
- `session_event` — event under spill (puzzle løst, hint, etc)
- `session_finished` — spill avsluttet
- `pong` — svar på ping
