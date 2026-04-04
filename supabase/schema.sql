create extension if not exists "pgcrypto";

create table if not exists lists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by text not null,
  is_preset boolean not null default false,
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
  is_public boolean not null default true,
  invite_code text not null unique,
  current_opening_index int not null default 0,
  status text not null default 'active' check (status in ('active', 'finished')),
  created_at timestamptz not null default now()
);

create index if not exists idx_rooms_public_status on rooms(is_public, status);

create table if not exists room_members (
  room_id uuid not null references rooms(id) on delete cascade,
  user_uuid text not null,
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
  score int not null check (score between 1 and 10),
  submitted_at timestamptz not null default now(),
  unique (room_id, list_opening_id, user_uuid)
);

create index if not exists idx_ratings_room_opening on ratings(room_id, list_opening_id);

create table if not exists room_rankings (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  list_opening_id uuid not null references list_openings(id) on delete cascade,
  ranking_type text not null check (ranking_type in ('group', 'personal')),
  user_uuid text,
  score numeric(5,2) not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_room_rankings_room on room_rankings(room_id, ranking_type);

-- RLS intentionally disabled for side-project simplicity
alter table lists disable row level security;
alter table list_openings disable row level security;
alter table rooms disable row level security;
alter table room_members disable row level security;
alter table ratings disable row level security;
alter table room_rankings disable row level security;
