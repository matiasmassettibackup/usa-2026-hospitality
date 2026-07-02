create table if not exists public.telegram_users (
  chat_id text primary key,
  username text,
  first_name text,
  last_name text,
  chat_title text,
  chat_type text,
  priority integer not null default 0,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  raw_user jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id bigserial primary key,
  chat_id text not null references public.telegram_users(chat_id) on delete cascade,
  match text not null,
  section text,
  section_code text,
  cheapest_per_category boolean not null default false,
  all_sections boolean not null default false,
  subscription jsonb not null,
  created_at timestamptz not null default now(),
  unique (chat_id, match, section, section_code, cheapest_per_category, all_sections)
);

create table if not exists public.bot_state (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.availability_events (
  id bigserial primary key,
  timestamp timestamptz not null,
  match text not null,
  teams text,
  venue text,
  city text,
  date text,
  section_code text,
  section_name text,
  lounge_title text,
  price_usd integer,
  available_quantity integer,
  can_create_cart boolean,
  created_at timestamptz not null default now()
);

create index if not exists subscriptions_chat_id_idx on public.subscriptions (chat_id);
create index if not exists subscriptions_match_idx on public.subscriptions (match);
create index if not exists availability_events_match_timestamp_idx on public.availability_events (match, timestamp desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_telegram_users_updated_at on public.telegram_users;
create trigger set_telegram_users_updated_at
before update on public.telegram_users
for each row execute function public.set_updated_at();

drop trigger if exists set_bot_state_updated_at on public.bot_state;
create trigger set_bot_state_updated_at
before update on public.bot_state
for each row execute function public.set_updated_at();
