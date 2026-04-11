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
- There are no seeded default credentials in migrations. Create admin users manually through the database when needed.
- Jikan responses are cached server-side in memory.
- YouTube IDs are persisted when list entries are created.

## Environment requirements
The app fails fast on startup when required variables are missing.

Required backend variables:
- `CLIENT_ORIGIN`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PARTYKIT_INTERNAL_SECRET`
- `PARTYKIT_API_SIGNING_SECRET`

Required client variables:
- `VITE_API_BASE_URL`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_PARTYKIT_URL`

Required PartyKit runtime variables:
- `PARTYKIT_API_BASE_URL`
- `PARTYKIT_INTERNAL_SECRET`
- `PARTYKIT_API_SIGNING_SECRET`

## Deploy runbook
1. Prepare secrets and env vars:
   - Set all required backend, client, and PartyKit variables.
   - Generate strong random values for `PARTYKIT_INTERNAL_SECRET` and `PARTYKIT_API_SIGNING_SECRET`.
2. Apply database changes:
   - Run migrations in order under `supabase/migrations`.
   - Ensure `supabase/schema.sql` and migration state stay aligned.
3. Build and deploy services:
   - `npm run build`
   - Deploy backend, client, and PartyKit with matching env vars.
4. Post-deploy verification:
   - Check `GET /api/health` returns `ok: true`.
   - Validate auth flow (register/login/profile/logout).
   - Validate room flow (create room, join code, play, rate, next opening, finish).
   - Validate PartyKit rejects invalid/missing session token connections.
   - Validate admin endpoints reject non-admin users with `401/403`.

## Vercel backend
- Deploy the backend from the repository root using the `api/[...path].js` function entrypoint.
- Do not run `app.listen()` on Vercel; the app is exported as a serverless handler there.
- Set `CLIENT_ORIGIN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PARTYKIT_INTERNAL_SECRET`, and `PARTYKIT_API_SIGNING_SECRET` in the Vercel project env vars.
- Keep the frontend on a separate deployment or static host unless you also wire a Vercel frontend build.

## Vercel frontend
- Deploy the frontend as a separate Vercel project with `client` as the root directory.
- The client already has SPA rewrites in `client/vercel.json`, so React Router paths keep working.
- Set `VITE_API_BASE_URL` to the backend Vercel URL, not `localhost`.
- Set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_PARTYKIT_URL` in the frontend project env vars.

## Secret rotation runbook
1. Generate new values for `PARTYKIT_INTERNAL_SECRET` and `PARTYKIT_API_SIGNING_SECRET`.
2. Update backend and PartyKit env vars together.
3. Redeploy backend and PartyKit.
4. Run health checks and room realtime smoke test.
5. Revoke old secrets from hosting platform.

## Security checklist
- No hardcoded credentials or secrets in repository files.
- RLS enabled for `app_users`, `app_user_sessions`, `lists`, `list_openings`, `rooms`, `room_members`, `ratings`, `room_rankings`, and `room_messages`.
- Admin endpoints require authenticated admin role.
- PartyKit validates session token on connect and rejects invalid clients.
- Internal PartyKit-backend calls require HMAC signature with timestamp/nonce.
- 500 responses are generic to clients; full detail is server-side logs only.
- Temporary analysis artifacts such as `tmp_openings_missing_youtube_links.*` and `.tmp_build_*youtube_links.js` are ignored and should stay out of commits.
