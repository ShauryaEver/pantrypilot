-- PantryPilot schema for Supabase (Postgres). Run once in: Supabase dashboard -> SQL Editor -> New query -> Run.
-- The server talks to Supabase with the SERVICE ROLE key (bypasses RLS). RLS is enabled with NO policies on every
-- table, so the public anon key can read and write nothing, even if it leaks.

create table if not exists users (
  id            bigint generated always as identity primary key,
  email         text not null unique,
  password_hash text,                       -- null for Google (Firebase) accounts
  firebase_uid  text unique,
  diet          text not null default 'none' check (diet in ('none','vegetarian','vegan')),
  allergens     jsonb not null default '[]'::jsonb,
  household     int  not null default 1 check (household between 1 and 12),
  failed_logins int  not null default 0,
  locked_until  bigint not null default 0,  -- epoch ms
  created_at    timestamptz not null default now()
);

create table if not exists pantry_items (
  id          bigint generated always as identity primary key,
  user_id     bigint not null references users(id) on delete cascade,
  name        text not null,
  quantity    double precision not null check (quantity > 0),
  unit        text not null,
  category    text not null,
  expires_on  date not null,
  cost        double precision not null default 0,
  status      text not null default 'active' check (status in ('active','used','wasted')),
  created_at  timestamptz not null default now()
);
create index if not exists idx_pantry_user_status on pantry_items(user_id, status, expires_on);

create table if not exists waste_events (
  id         bigint generated always as identity primary key,
  user_id    bigint not null references users(id) on delete cascade,
  item_name  text not null,
  category   text not null,
  kind       text not null check (kind in ('rescued','used','wasted')),
  cost       double precision not null default 0,
  co2_kg     double precision not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_events_user on waste_events(user_id, created_at);

create table if not exists plans (
  id               bigint generated always as identity primary key,
  user_id          bigint not null references users(id) on delete cascade,
  mode             text not null,
  json             jsonb not null,
  coverage         double precision not null default 0,
  projected_co2_kg double precision not null default 0,
  projected_money  double precision not null default 0,
  created_at       timestamptz not null default now()
);

create table if not exists audit_log (
  id         bigint generated always as identity primary key,
  user_id    bigint,
  event      text not null,
  detail     text,
  ip         text,
  created_at timestamptz not null default now()
);

create table if not exists llm_cache (
  key        text primary key,
  value      jsonb not null,
  created_at bigint not null               -- epoch ms
);

create table if not exists ai_usage (
  user_id bigint not null references users(id) on delete cascade,
  day     date not null,
  calls   int not null default 0,
  primary key (user_id, day)
);

-- Atomic daily AI quota counter (returns the new count).
create or replace function increment_ai_usage(p_user bigint, p_day date)
returns int language sql security invoker as $$
  insert into ai_usage (user_id, day, calls) values (p_user, p_day, 1)
  on conflict (user_id, day) do update set calls = ai_usage.calls + 1
  returning calls;
$$;

-- Atomic "mark used/wasted + log impact event" so the two writes can never diverge.
create or replace function resolve_item(p_user bigint, p_item bigint, p_status text, p_kind text, p_co2 double precision)
returns void language plpgsql security invoker as $$
declare it pantry_items%rowtype;
begin
  update pantry_items set status = p_status
   where id = p_item and user_id = p_user and status = 'active'
  returning * into it;
  if not found then raise exception 'item not found'; end if;
  insert into waste_events (user_id, item_name, category, kind, cost, co2_kg)
  values (p_user, it.name, it.category, p_kind, it.cost, p_co2);
end $$;

-- Lock everything down: RLS on, no policies => anon/authenticated roles get nothing.
alter table users         enable row level security;
alter table pantry_items  enable row level security;
alter table waste_events  enable row level security;
alter table plans         enable row level security;
alter table audit_log     enable row level security;
alter table llm_cache     enable row level security;
alter table ai_usage      enable row level security;

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
