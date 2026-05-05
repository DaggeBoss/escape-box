# Escape Box — Admin Portal

Statisk Netlify-deploy. Ingen bygg-steg.

## Oppsett

1. Endre `window.APP_CONFIG` i `index.html` til riktige URL-er:
   - `API_BASE`: Railway-URL til backend (uten trailing slash)
   - `WS_URL`: WebSocket-URL (`wss://...railway.app/ws`)
   - `PARTICIPANT_URL`: URL til deltager-frontenden (brukes til QR-koder)

2. På backend må `FRONTEND_URL` (env-variabel) inkludere admin-portalens URL slik at CORS slipper den gjennom. Bruk komma for flere:
   ```
   FRONTEND_URL=https://admin.escapebox.no,https://play.escapebox.no
   ```

## Default superadmin

Ved første oppstart av backend opprettes en superadmin-konto:
- Epost: `SUPERADMIN_EMAIL` (env, default: `[email protected]`)
- Passord: `SUPERADMIN_PASSWORD` (env, default: `changeme123`)

Logg inn og bytt passord umiddelbart under «Min profil».

## Roller

- **Superadmin** — full systemtilgang, eier scenariobiblioteket og alle bedrifter
- **Bedriftsadmin** (`org_admin`) — administrerer egen bedrift, oppretter eventer
- **Gamemaster** — kjører eventer (samme tilgangsnivå som org_admin per nå)
- **Deltager** — logger inn med event_code + team_code + PIN i deltager-frontenden

## Filer

- `index.html` — skall + login
- `styles.css` — Field Terminal designsystem
- `app.js` — hele SPA-en (router, views, modaler, WS, API)
- `netlify.toml` — deploy + SPA-redirects
