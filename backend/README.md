# Escape Box — Backend

Multi-tenant plattform for escape room/event-spill. Express + PostgreSQL + WebSocket på Railway.

## Arkitektur

```
organizations ─┬── users (superadmin / org_admin / gamemaster)
               └── events ── teams ── sessions ── puzzle_events
                       │
scenarios ─────────────┘
   └── scenario_data JSONB { passwords, cards, minigames, fictional_server, settings }
```

**Roller:**
- `superadmin` — eier scenarier, oppretter bedrifter, har tilgang til alt
- `org_admin` — administrerer sin bedrift, oppretter events og brukere i samme bedrift
- `gamemaster` — kjører events
- `participant` — deltager (egen tabell, kommer i sesjon 4) — logger inn med SMS-kode

**Token-levetid:**
- Admin/gamemaster: 180 dager
- Deltager: 12 timer (hard cutoff)

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
3. **Legg til Postgres**: Railway → New → Database → PostgreSQL (`DATABASE_URL` settes automatisk)
4. **Sett miljøvariabler** under Variables (se under)
5. **Generate Domain** under Settings → Networking
6. Backend er nå tilgjengelig på `https://din-app.up.railway.app`

## Miljøvariabler

| Variabel | Påkrevd | Beskrivelse |
|---|---|---|
| `DATABASE_URL` | Ja | Settes automatisk av Railway |
| `JWT_SECRET` | Ja | Tilfeldig lang streng, brukes til å signere tokens |
| `FRONTEND_URL` | Ja | Netlify-URL(er), kommaseparert eller `*` |
| `PORT` | Nei | Default 3000 |
| `SUPERADMIN_EMAIL` | Nei | Default `[email protected]` — settes kun ved første start |
| `SUPERADMIN_PASSWORD` | Nei | Default `changeme123` — settes kun ved første start |
| `DROPBOX_APP_KEY` | Ja | Fra Dropbox App Console |
| `DROPBOX_APP_SECRET` | Ja | Fra Dropbox App Console |
| `DROPBOX_REFRESH_TOKEN` | Ja | OAuth refresh token |
| `DROPBOX_NAMESPACE_ID` | Nei | Kun nødvendig hvis filer ligger i en team folder |

Kommer i senere sesjoner:
- `SMS_PROVIDER` (linkmobility/sveve/mock) — sesjon 4
- `SMS_API_KEY` osv. — sesjon 4
- `PHONE_LOOKUP_PROVIDER` (1881/mock) — sesjon 5
- `GOOGLE_STREETVIEW_API_KEY` — sesjon 5

## API-endepunkter

### Offentlig (ingen token)
- `POST /api/auth/login` — admin login (epost + passord)
- `POST /api/auth/team-login` — deltager login (event_code + team_code + PIN) — *NB: erstattes av SMS-flyt i sesjon 4*
- `POST /api/sessions/start` — start sesjon for et lag
- `GET  /api/sessions/active/:team_id` — hent aktiv sesjon
- `POST /api/sessions/:id/event` — logg event under spill
- `POST /api/sessions/:id/finish` — avslutt sesjon
- `WS   /ws` — sanntidsoppdateringer (broadcast, kan subscribe til event_id)

### Admin (krever Bearer token)

**Auth & profil:**
- `GET  /api/auth/me` — info om innlogget bruker
- `POST /api/auth/change-password`
- `POST /api/auth/update-profile`

**Organisasjoner** (superadmin):
- `GET    /api/organizations`
- `GET    /api/organizations/:id`
- `POST   /api/organizations` — oppretter også første org_admin
- `DELETE /api/organizations/:id`

**Brukere** (superadmin + org_admin):
- `GET    /api/users`
- `POST   /api/users`
- `PATCH  /api/users/:id`
- `DELETE /api/users/:id`

**Scenarier** (superadmin):
- `GET    /api/scenarios` (alle innloggede ser aktive)
- `GET    /api/scenarios/:id`
- `POST   /api/scenarios`
- `PATCH  /api/scenarios/:id`
- `DELETE /api/scenarios/:id`

**Events** (org_admin + superadmin):
- `GET    /api/events`
- `GET    /api/events/:id` — med teams
- `POST   /api/events` — auto-genererer event-kode og lag med PIN
- `PATCH  /api/events/:id`
- `DELETE /api/events/:id`
- `GET    /api/events/:id/teams/:teamId`
- `POST   /api/events/:id/teams/:teamId/regenerate-pin`
- `GET    /api/sessions/event/:event_id/active`

**Opplastinger** (superadmin):
- `POST   /api/uploads/image` — opplasting til Dropbox (kind: `cards` | `minigames`)
- `DELETE /api/uploads/image` — sletter fra Dropbox

## WebSocket-meldinger

**Klient → server:**
- `{ type: 'ping' }`
- `{ type: 'subscribe', event_id }` — abonner på meldinger for ett spesifikt event

**Server → klient:**
- `{ type: 'welcome', timestamp }` — ved tilkobling
- `{ type: 'pong' }` — svar på ping
- `{ type: 'subscribed', event_id }` — bekreftelse på abonnement
- `{ type: 'event_created', event }` — nytt event
- `{ type: 'event_updated', event }` — event endret
- `{ type: 'session_started', session, event_id }`
- `{ type: 'session_event', session, event_id, event }`
- `{ type: 'session_finished', session, event_id }`

## Scenario-data-skjema

Hvert scenario har et `scenario_data` JSONB-felt med følgende struktur:

```js
{
  passwords: [
    {
      id: "uuid",
      code: "1234",           // 4-sifret kode
      points: 100,
      triggers: {
        cards: ["card-id-1"],       // refererer til cards-listen
        minigames: ["minigame-id"], // refererer til minigames-listen
        unlock_files: ["folder/file"],
        narrative: "Hint eller historiebit som vises"
      },
      hint: "Valgfritt hint hvis lag står fast",
      hint_penalty: 20
    }
  ],
  cards: [
    { id, title, body, image_url? }
  ],
  minigames: [
    { id, name, html_path, dropbox_url, completion_event }
  ],
  fictional_server: {
    name: "Server-navn",
    folders: [
      {
        name: "Mappenavn",
        files: [
          { name, type, url, source?, auto_per_player? }
        ]
      }
    ]
  },
  settings: {
    time_limit_enabled: true,
    show_score: true,
    require_consent: true,
    streetview_enabled: true
  }
}
```

Eksisterende scenarier fra v1 (med `coordinates`/`grid`-struktur) migreres
automatisk til tomt nytt skjema ved oppstart.

## Versjon

**v2.1.0** — sesjon 1: Investigation board fjernet, token-splitt, scenario_data-skjema redesignet for passord-basert spilllogikk.
