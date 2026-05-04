#!/bin/bash

# ==============================================
#  Escape Box - Lokal utviklingsstarter
# ==============================================
# Starter backend (port 3000) og frontend-server (port 5173),
# åpner Chrome på frontend-URL-en.
# Trykk Ctrl+C i terminalvinduet for å stoppe alt.

set -e

# Finn riktig prosjektmappe (samme mappe som dette skriptet ligger i)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Farger for lesbarhet
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo -e "${GREEN}  🎮 ESCAPE BOX — LOKAL UTVIKLING${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo ""

# Sjekk at backend/.env finnes
if [ ! -f "backend/.env" ]; then
  echo -e "${RED}⚠️  backend/.env mangler!${NC}"
  echo "   Kopier backend/.env.example til backend/.env og fyll inn DATABASE_URL"
  exit 1
fi

# Sjekk at PostgreSQL kjører (port 5432)
if ! nc -z localhost 5432 2>/dev/null; then
  echo -e "${RED}⚠️  PostgreSQL kjører ikke på port 5432${NC}"
  echo "   Åpne Postgres.app og start serveren, så prøv igjen."
  echo ""
  read -p "Trykk Enter for å lukke vinduet..."
  exit 1
fi
echo -e "${GREEN}✓${NC} PostgreSQL kjører"

# Sjekk at backend/node_modules finnes — installer hvis ikke
if [ ! -d "backend/node_modules" ]; then
  echo -e "${YELLOW}📦 Installerer backend-pakker (første gang)...${NC}"
  (cd backend && npm install)
fi
echo -e "${GREEN}✓${NC} Backend-pakker OK"

echo ""
echo -e "${GREEN}🚀 Starter tjenester...${NC}"
echo ""

# Funksjon for å drepe alle child-prosesser ved Ctrl+C
cleanup() {
  echo ""
  echo -e "${YELLOW}🛑 Stopper alle tjenester...${NC}"
  # Drep alle bakgrunnsprosesser fra dette skriptet
  pkill -P $$ 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

# Start backend i bakgrunnen
(cd backend && npm run dev) &
BACKEND_PID=$!
echo -e "${GREEN}✓${NC} Backend startet (PID $BACKEND_PID) på http://localhost:3000"

# Start frontend-server (Python sin innebygde) i bakgrunnen
(cd frontend && python3 -m http.server 5173 >/dev/null 2>&1) &
FRONTEND_PID=$!
echo -e "${GREEN}✓${NC} Frontend startet (PID $FRONTEND_PID) på http://localhost:5173"

# Vent litt så servere rekker å starte
sleep 2

# Åpne Chrome på frontend-URL
echo ""
echo -e "${GREEN}🌐 Åpner Chrome...${NC}"
open -a "Google Chrome" "http://localhost:5173"

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Alt kjører! Trykk Ctrl+C for å stoppe.${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo ""
echo "  Backend:  http://localhost:3000"
echo "  Frontend: http://localhost:5173"
echo "  Admin:    http://localhost:5173 → fane 'Admin'"
echo "            (admin / passordet du satte i .env)"
echo ""

# Vent på at brukeren stopper med Ctrl+C
wait
