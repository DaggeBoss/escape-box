# Escape Box

Komplett løsning for Escape Box-spill med lag, sanntidsoversikt for game master og leaderboard.

## Stack

- **Frontend**: Single-file HTML SPA → Netlify
- **Backend**: Node.js + Express + WebSocket → Railway
- **Database**: PostgreSQL → Railway
- **Auth**: JWT for admin

## Mappestruktur

```
escape-box/
├── frontend/   ← eget GitHub-repo, kobles til Netlify
└── backend/    ← eget GitHub-repo, kobles til Railway
```

## Komplett deploy-flyt

### 1. Backend først (du trenger URL-en til frontend)

```bash
cd backend
git init
git add .
git commit -m "Initial backend"
gh repo create escape-box-backend --private --source=. --push
# eller manuelt: legg til remote og push
```

I Railway:
1. **New Project → Deploy from GitHub repo** → velg `escape-box-backend`
2. **+ New → Database → PostgreSQL** (DATABASE_URL settes automatisk)
3. **Variables**:
   - `JWT_SECRET` = `<generer en lang tilfeldig streng>`
   - `DEFAULT_ADMIN_PASSWORD` = `<ditt midlertidige passord>`
   - `FRONTEND_URL` = `*` (oppdaterer du etter steg 2)
4. **Settings → Networking → Generate Domain** → kopier URL-en

### 2. Frontend

Åpne `frontend/index.html`, finn `API_URL` rundt linje 290, og lim inn Railway-URL-en.

```bash
cd frontend
git init
git add .
git commit -m "Initial frontend"
gh repo create escape-box-frontend --public --source=. --push
```

I Netlify:
1. **Add new site → Import from GitHub** → velg `escape-box-frontend`
2. Build command tom, publish directory `.`
3. Deploy → kopier URL-en (`https://...netlify.app`)

### 3. Lukk loopen

Tilbake i Railway → Variables → sett `FRONTEND_URL` til Netlify-URL-en. Backend restartes automatisk.

### 4. Logg inn og bytt admin-passord

- Åpne Netlify-URL → Admin
- Logg inn med `admin` / `<DEFAULT_ADMIN_PASSWORD>`
- (TODO: legg til UI for å bytte passord — det er hash-et i databasen og kan endres direkte i Railway sin DB-konsoll inntil videre)

## Lokal utvikling

To terminaler:

```bash
# Terminal 1
cd backend && npm install && npm run dev

# Terminal 2
cd frontend && python3 -m http.server 5173
```

Åpne `http://localhost:5173`. Når API_URL ser `localhost` peker den automatisk på `http://localhost:3000`.

## Datamodell

- **teams** — lagene som kan spille (navn, 4-tegns kode)
- **sessions** — hvert spill (start/slutt, status, tid, hint, current_puzzle)
- **puzzle_events** — alle hendelser under spillet (puzzle løst, hint, custom events) som JSONB
- **admins** — admin-brukere

## Utvidelse

Strukturen er klar for:
- Flere bokser — bare legg til i frontend `<select>`-en, `box_name` er fri tekst i DB
- Custom puzzle-typer — bruk `puzzle_events.payload` (JSONB)
- Flere admin-brukere — legg til endepunkt for å opprette nye admins
- Spiller-app som egen visning — bruk eksisterende endepunkter
