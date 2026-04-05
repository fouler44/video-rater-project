create extension if not exists "pgcrypto";

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  display_name text not null,
  avatar_url text,
  role text not null default 'user' check (role in ('user', 'admin')),
  legacy_uuid text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app_user_credentials (
  user_id uuid primary key references app_users(id) on delete cascade,
  password_hash text not null,
  updated_at timestamptz not null default now()
);

create table if not exists app_user_sessions (
  token text primary key,
  user_id uuid not null references app_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now()
);

create index if not exists idx_app_user_sessions_user_id on app_user_sessions(user_id);
create index if not exists idx_app_user_sessions_expires_at on app_user_sessions(expires_at);

create table if not exists lists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by text not null,
  is_preset boolean not null default false,
  list_source text not null default 'mal' check (list_source in ('mal', 'youtube')),
  created_at timestamptz not null default now()
);

create table if not exists list_openings (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references lists(id) on delete cascade,
  anime_id bigint not null,
  anime_title text not null,
  opening_label text not null,
  youtube_video_id text,
  youtube_start_seconds int not null default 0,
  thumbnail_url text,
  order_index int not null default 0
);

create index if not exists idx_list_openings_list on list_openings(list_id, order_index);

create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  list_id uuid not null references lists(id),
  host_uuid text not null,
  owner_user_id uuid not null references app_users(id) on delete restrict,
  is_public boolean not null default true,
  invite_code text not null unique,
  current_opening_index int not null default 0,
  status text not null default 'waiting' check (status in ('waiting', 'playing', 'finished')),
  created_at timestamptz not null default now()
);

create index if not exists idx_rooms_public_status on rooms(is_public, status);

create table if not exists room_members (
  room_id uuid not null references rooms(id) on delete cascade,
  user_uuid text not null,
  user_id uuid references app_users(id) on delete cascade,
  display_name text not null,
  avatar_url text,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_uuid)
);

alter table room_members add column if not exists avatar_url text;

create table if not exists ratings (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  list_opening_id uuid not null references list_openings(id) on delete cascade,
  user_uuid text not null,
  user_id uuid references app_users(id) on delete cascade,
  score int not null check (score between 1 and 10),
  submitted_at timestamptz not null default now(),
  unique (room_id, list_opening_id, user_uuid)
);

create index if not exists idx_ratings_room_opening on ratings(room_id, list_opening_id);

create table if not exists room_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  user_uuid text not null,
  user_name text not null,
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_room_messages_room_created on room_messages(room_id, created_at);

create table if not exists room_rankings (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  list_opening_id uuid not null references list_openings(id) on delete cascade,
  ranking_type text not null check (ranking_type in ('group', 'personal')),
  user_uuid text,
  user_id uuid references app_users(id) on delete cascade,
  score numeric(5,2) not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_room_rankings_room on room_rankings(room_id, ranking_type);

alter table app_users enable row level security;
alter table app_user_credentials enable row level security;
alter table app_user_sessions enable row level security;
alter table lists enable row level security;
alter table list_openings enable row level security;
alter table rooms enable row level security;
alter table room_members enable row level security;
alter table ratings enable row level security;
alter table room_messages enable row level security;
alter table room_rankings enable row level security;

drop policy if exists app_users_no_access on app_users;
create policy app_users_no_access on app_users
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists app_user_credentials_no_access on app_user_credentials;
create policy app_user_credentials_no_access on app_user_credentials
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists app_user_sessions_no_access on app_user_sessions;
create policy app_user_sessions_no_access on app_user_sessions
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists lists_read_all on lists;
create policy lists_read_all on lists
  for select
  to anon, authenticated
  using (true);

drop policy if exists lists_write_blocked on lists;
create policy lists_write_blocked on lists
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists list_openings_read_all on list_openings;
create policy list_openings_read_all on list_openings
  for select
  to anon, authenticated
  using (true);

drop policy if exists list_openings_write_blocked on list_openings;
create policy list_openings_write_blocked on list_openings
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists rooms_read_all on rooms;
create policy rooms_read_all on rooms
  for select
  to anon, authenticated
  using (true);

drop policy if exists rooms_write_blocked on rooms;
create policy rooms_write_blocked on rooms
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists room_members_read_all on room_members;
create policy room_members_read_all on room_members
  for select
  to anon, authenticated
  using (true);

drop policy if exists room_members_write_blocked on room_members;
create policy room_members_write_blocked on room_members
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists ratings_read_all on ratings;
create policy ratings_read_all on ratings
  for select
  to anon, authenticated
  using (true);

drop policy if exists ratings_write_blocked on ratings;
create policy ratings_write_blocked on ratings
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists room_messages_read_all on room_messages;
create policy room_messages_read_all on room_messages
  for select
  to anon, authenticated
  using (true);

drop policy if exists room_messages_write_blocked on room_messages;
create policy room_messages_write_blocked on room_messages
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists room_rankings_read_all on room_rankings;
create policy room_rankings_read_all on room_rankings
  for select
  to anon, authenticated
  using (true);

drop policy if exists room_rankings_write_blocked on room_rankings;
create policy room_rankings_write_blocked on room_rankings
  for all
  to anon, authenticated
  using (false)
  with check (false);
