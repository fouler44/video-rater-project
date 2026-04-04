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
- Auth now uses app users + backend sessions (username/password + bearer token).
- Rooms now track a real `owner_user_id`; only owner or admin can control/delete a room.
- Seeded admin account after running latest migration: `admin / admin1234` (change immediately in DB).
- Jikan responses are cached server-side in memory.
- YouTube IDs are persisted when list entries are created.
