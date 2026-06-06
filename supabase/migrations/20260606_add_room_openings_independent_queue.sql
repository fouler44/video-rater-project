alter table public.list_openings add column if not exists theme_kind text;
alter table public.list_openings add column if not exists youtube_start_seconds int not null default 0;

create table if not exists public.room_openings (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  source_list_opening_id uuid references public.list_openings(id) on delete set null,
  anime_id bigint not null,
  anime_title text not null,
  opening_label text not null,
  theme_kind text,
  youtube_video_id text,
  youtube_start_seconds int not null default 0,
  thumbnail_url text,
  order_index int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_room_openings_room on public.room_openings(room_id, order_index);
create index if not exists idx_room_openings_source on public.room_openings(source_list_opening_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'room_openings_room_id_source_list_opening_id_key'
      and conrelid = 'public.room_openings'::regclass
  ) then
    alter table public.room_openings
      add constraint room_openings_room_id_source_list_opening_id_key
      unique (room_id, source_list_opening_id);
  end if;
end $$;

alter table public.ratings add column if not exists room_opening_id uuid;
alter table public.room_rankings add column if not exists room_opening_id uuid;

alter table public.ratings alter column list_opening_id drop not null;
alter table public.room_rankings alter column list_opening_id drop not null;

alter table public.ratings drop constraint if exists ratings_list_opening_id_fkey;
alter table public.ratings
  add constraint ratings_list_opening_id_fkey
  foreign key (list_opening_id) references public.list_openings(id) on delete set null;

alter table public.room_rankings drop constraint if exists room_rankings_list_opening_id_fkey;
alter table public.room_rankings
  add constraint room_rankings_list_opening_id_fkey
  foreign key (list_opening_id) references public.list_openings(id) on delete set null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ratings_room_opening_id_fkey'
      and conrelid = 'public.ratings'::regclass
  ) then
    alter table public.ratings
      add constraint ratings_room_opening_id_fkey
      foreign key (room_opening_id) references public.room_openings(id) on delete cascade;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'room_rankings_room_opening_id_fkey'
      and conrelid = 'public.room_rankings'::regclass
  ) then
    alter table public.room_rankings
      add constraint room_rankings_room_opening_id_fkey
      foreign key (room_opening_id) references public.room_openings(id) on delete cascade;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ratings_room_id_room_opening_id_user_uuid_key'
      and conrelid = 'public.ratings'::regclass
  ) then
    alter table public.ratings
      add constraint ratings_room_id_room_opening_id_user_uuid_key
      unique (room_id, room_opening_id, user_uuid);
  end if;
end $$;

create index if not exists idx_ratings_room_room_opening
  on public.ratings(room_id, room_opening_id);

create index if not exists idx_room_rankings_room_opening
  on public.room_rankings(room_id, room_opening_id);

insert into public.room_openings (
  room_id,
  source_list_opening_id,
  anime_id,
  anime_title,
  opening_label,
  theme_kind,
  youtube_video_id,
  youtube_start_seconds,
  thumbnail_url,
  order_index
)
select
  rooms.id,
  list_openings.id,
  list_openings.anime_id,
  list_openings.anime_title,
  list_openings.opening_label,
  list_openings.theme_kind,
  list_openings.youtube_video_id,
  list_openings.youtube_start_seconds,
  list_openings.thumbnail_url,
  list_openings.order_index
from public.rooms
join public.list_openings on list_openings.list_id = rooms.list_id
where not exists (
  select 1
  from public.room_openings
  where room_openings.room_id = rooms.id
    and room_openings.source_list_opening_id = list_openings.id
)
on conflict (room_id, source_list_opening_id) do nothing;

update public.ratings
set room_opening_id = room_openings.id
from public.room_openings
where ratings.room_id = room_openings.room_id
  and ratings.list_opening_id = room_openings.source_list_opening_id
  and ratings.room_opening_id is null;

update public.room_rankings
set room_opening_id = room_openings.id
from public.room_openings
where room_rankings.room_id = room_openings.room_id
  and room_rankings.list_opening_id = room_openings.source_list_opening_id
  and room_rankings.room_opening_id is null;

alter table public.room_openings enable row level security;

drop policy if exists room_openings_read_all on public.room_openings;
create policy room_openings_read_all on public.room_openings
  for select
  to anon, authenticated
  using (true);

drop policy if exists room_openings_write_blocked on public.room_openings;
create policy room_openings_write_blocked on public.room_openings
  for all
  to anon, authenticated
  using (false)
  with check (false);
