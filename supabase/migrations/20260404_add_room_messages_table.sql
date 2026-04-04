create table if not exists public.room_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_uuid text not null,
  user_name text not null,
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_room_messages_room_created on public.room_messages(room_id, created_at);

alter table public.room_messages disable row level security;
