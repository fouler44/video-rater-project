create extension if not exists "pgcrypto";

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  display_name text not null,
  avatar_url text,
  role text not null default 'user' check (role in ('user', 'admin')),
  legacy_uuid text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_user_credentials (
  user_id uuid primary key references public.app_users(id) on delete cascade,
  password_hash text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.app_user_sessions (
  token text primary key,
  user_id uuid not null references public.app_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now()
);

create index if not exists idx_app_user_sessions_user_id on public.app_user_sessions(user_id);
create index if not exists idx_app_user_sessions_expires_at on public.app_user_sessions(expires_at);

insert into public.app_users (legacy_uuid, username, display_name, role)
select
  src.legacy_uuid,
  ('legacy_' || substring(replace(src.legacy_uuid, '-', '') from 1 for 24)) as username,
  coalesce(max(src.display_name) filter (where src.display_name is not null and src.display_name <> ''), 'Legacy User') as display_name,
  'user'
from (
  select host_uuid as legacy_uuid, null::text as display_name from public.rooms where host_uuid is not null and host_uuid <> ''
  union all
  select user_uuid as legacy_uuid, display_name from public.room_members where user_uuid is not null and user_uuid <> ''
  union all
  select user_uuid as legacy_uuid, null::text as display_name from public.ratings where user_uuid is not null and user_uuid <> ''
) src
group by src.legacy_uuid
on conflict (legacy_uuid) do update
set display_name = excluded.display_name;

alter table public.rooms add column if not exists owner_user_id uuid;

alter table public.rooms drop constraint if exists rooms_status_check;

update public.rooms
set status = 'waiting'
where status is null or status not in ('waiting', 'playing', 'finished');

alter table public.rooms
  add constraint rooms_status_check check (status in ('waiting', 'playing', 'finished'));

update public.rooms r
set owner_user_id = u.id
from public.app_users u
where r.owner_user_id is null
  and u.legacy_uuid = r.host_uuid;

update public.rooms
set owner_user_id = (
  select id from public.app_users order by created_at asc limit 1
)
where owner_user_id is null;

alter table public.rooms alter column owner_user_id set not null;

alter table public.rooms
  add constraint rooms_owner_user_id_fkey
  foreign key (owner_user_id) references public.app_users(id) on delete restrict;

alter table public.room_members add column if not exists user_id uuid;
update public.room_members rm
set user_id = u.id
from public.app_users u
where rm.user_id is null
  and u.legacy_uuid = rm.user_uuid;

alter table public.room_members
  add constraint room_members_user_id_fkey
  foreign key (user_id) references public.app_users(id) on delete cascade;

create index if not exists idx_room_members_user_id on public.room_members(user_id);

alter table public.ratings add column if not exists user_id uuid;
update public.ratings r
set user_id = u.id
from public.app_users u
where r.user_id is null
  and u.legacy_uuid = r.user_uuid;

alter table public.ratings
  add constraint ratings_user_id_fkey
  foreign key (user_id) references public.app_users(id) on delete cascade;

create index if not exists idx_ratings_user_id on public.ratings(user_id);

alter table public.room_rankings add column if not exists user_id uuid;
update public.room_rankings rr
set user_id = u.id
from public.app_users u
where rr.user_id is null
  and u.legacy_uuid = rr.user_uuid;

alter table public.room_rankings
  add constraint room_rankings_user_id_fkey
  foreign key (user_id) references public.app_users(id) on delete cascade;

create index if not exists idx_room_rankings_user_id on public.room_rankings(user_id);

insert into public.app_users (username, display_name, role, avatar_url)
values (
  'admin',
  'Administrator',
  'admin',
  'https://api.dicebear.com/9.x/thumbs/svg?seed=admin'
)
on conflict (username) do nothing;

insert into public.app_user_credentials (user_id, password_hash)
select id, 'sha256$admin_seed$' || encode(digest('admin1234' || 'admin_seed', 'sha256'), 'hex')
from public.app_users
where username = 'admin'
on conflict (user_id) do nothing;

alter table public.app_users disable row level security;
alter table public.app_user_credentials disable row level security;
alter table public.app_user_sessions disable row level security;
