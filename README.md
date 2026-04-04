# Anime Opening Rater

Fun full-stack app to watch and rate anime openings in synced rooms.

## Stack
- React + Vite
- Node.js + Express
- Supabase (Postgres)
- PartyKit (realtime sync)
- Jikan v4 API + YouTube Data API v3

## Monorepo structure
- `client` → React frontend
- `server` → Express API + static host
- `partykit` → realtime room server
- `supabase/schema.sql` → DB schema

## Quick start
1. Install dependencies:
   - `npm install`
2. Create env files:
   - copy root `.env.example` to `.env`
   - copy relevant `VITE_*` values into `client/.env`
3. Run Supabase schema from `supabase/schema.sql`.
4. Start dev stack:
   - `npm run dev`

## URLs (default)
- Frontend: http://localhost:5173
- Backend: http://localhost:4000
- PartyKit WS: ws://localhost:1999

## Notes
- No email/password auth. Identity is UUID + display name in localStorage.
- Jikan responses are cached server-side in memory.
- YouTube IDs are persisted when list entries are created.
