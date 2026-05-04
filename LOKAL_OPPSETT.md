# Lokalt oppsett — Escape Box

Steg-for-steg guide for å kjøre prosjektet lokalt på Mac.

## Engangsoppsett

### 1. Sørg for at Postgres.app kjører

Åpne Postgres.app (elefant-ikonet i menylinjen). Hvis du ikke ser det, start den fra Programmer.

Du skal se "Running on Port 5432" i Postgres.app-vinduet.

### 2. Lag en database for Escape Box

Klikk på databasen din i Postgres.app (typisk `dageivindevensen`) for å åpne psql-terminalen. Eller åpne Terminal og kjør:

```bash
/Applications/Postgres.app/Contents/Versions/latest/bin/psql -d postgres
```

Når du er inne i psql-prompten (`postgres=#`), kjør:

```sql
CREATE DATABASE escapebox;
\q
```

(Backslash q for å avslutte psql.)

### 3. Lag .env-fil i backend-mappen

I terminalen:

```bash
cd "/Users/dageivindevensen/Dropbox (Privat)/Dagge Games/Kodeprosjekter/escape-box/backend"
cp .env.example .env
```

Åpne `.env` i en editor (TextEdit fungerer fint) og endre den til:

```
PORT=3000
DATABASE_URL=postgresql://dageivindevensen@localhost:5432/escapebox
FRONTEND_URL=http://localhost:5173
JWT_SECRET=lokal-utvikling-bytt-meg-i-prod
DEFAULT_ADMIN_PASSWORD=dagge2026
```

(Bytt `dageivindevensen` i DATABASE_URL hvis Postgres.app-brukeren din heter noe annet — du ser brukernavnet i Postgres.app-vinduet under "Connection".)

### 4. Installer backend-pakker

```bash
npm install
```

(Kjøres kun første gang.)

### 5. Gjør start-skriptet kjørbart

```bash
cd "/Users/dageivindevensen/Dropbox (Privat)/Dagge Games/Kodeprosjekter/escape-box"
chmod +x start-local.sh
```

## Daglig bruk

### Slik starter du:

Dobbeltklikk **Start Escape Box.app** på skrivebordet eller dokken.

(Eller kjør `./start-local.sh` i terminal hvis du foretrekker det.)

Et terminalvindu åpnes, sjekker at alt er på plass, og starter backend + frontend. Chrome åpnes automatisk på `http://localhost:5173`.

### Slik stopper du:

Trykk **Ctrl+C** i terminalvinduet. Alle tjenester stoppes pent.

## Lage Automator-app for dokken

1. Åpne **Automator** (i Programmer)
2. Velg **Programm** (Application) som dokumenttype
3. I søkefeltet til venstre, søk etter **"Kjør Shell-skript"** ("Run Shell Script")
4. Dra det inn i arbeidsområdet
5. Sett **Skall** til `/bin/bash`
6. Lim inn dette i tekstboksen:

```bash
osascript -e 'tell application "Terminal" to do script "cd \"/Users/dageivindevensen/Dropbox (Privat)/Dagge Games/Kodeprosjekter/escape-box\" && ./start-local.sh"'
osascript -e 'tell application "Terminal" to activate'
```

7. **Fil → Lagre som...** → kall den `Start Escape Box` → Lagre på Skrivebordet
8. Dra `Start Escape Box.app` fra Skrivebordet ned til dokken

Nå har du en knapp på dokken som starter alt!

## Tips

- **Endre kode**: backend restartes automatisk når du endrer .js-filer (takket være `node --watch`). For frontend er det bare å trykke F5/Cmd+R i nettleseren.
- **Se backend-logger**: alt vises i terminalvinduet — også database-oppstart og WebSocket-tilkoblinger.
- **Tøm databasen og start friskt**: i psql, kjør `DROP DATABASE escapebox; CREATE DATABASE escapebox;` så bygger backend tabellene på nytt ved neste start.
- **Se hva som ligger i databasen**: `\dt` i psql viser alle tabeller, `SELECT * FROM teams;` viser innhold.
