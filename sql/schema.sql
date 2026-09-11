-- Padel League Manager schema.
-- Paste this into the Supabase SQL editor for the new project (SQL Editor -> New query -> Run).

create extension if not exists "pgcrypto";

create table leagues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  start_date date,
  num_teams int,
  num_courts int not null default 1,
  scoring_config jsonb not null default '{"win":3,"draw":1,"loss":0}',
  playoff_size int not null default 8,
  status text not null default 'draft' check (status in ('draft','active','playoffs','completed','archived')),
  created_at timestamptz not null default now()
);

create table teams (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  name text not null,
  player1 text not null,
  player2 text not null,
  access_code text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table fixtures (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  week int not null,
  date date,
  court int,
  time_slot int default 1,
  team1_id uuid references teams(id),
  team2_id uuid references teams(id),
  stage text not null default 'league' check (stage in ('league','QF','SF','F')),
  bracket_slot text,
  next_fixture_id uuid references fixtures(id),
  next_slot int check (next_slot in (1,2)),
  status text not null default 'scheduled' check (status in ('scheduled','completed','bye')),
  created_at timestamptz not null default now()
);

create table results (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references fixtures(id) on delete cascade,
  team1_score int not null,
  team2_score int not null,
  submitted_by_team_id uuid references teams(id),
  submitted_at timestamptz not null default now(),
  confirmation_status text not null default 'pending' check (confirmation_status in ('pending','confirmed','disputed')),
  confirmed_by_team_id uuid references teams(id),
  confirmed_at timestamptz,
  dispute_reason text,
  disputed_at timestamptz,
  admin_override boolean not null default false,
  superseded boolean not null default false,
  created_at timestamptz not null default now()
);

create table keepalive (
  id int primary key default 1,
  pinged_at timestamptz
);

create index on teams(league_id);
create index on fixtures(league_id);
create index on fixtures(next_fixture_id);
create index on results(fixture_id);

-- RLS: enabled but permissive, gated only by possession of the public anon
-- key (same trust model as the sibling Americano app, which has no real
-- server-side auth either). Team/admin scoping is enforced client-side by
-- what the UI shows and lets each team submit against - not by the database.
-- See the plan doc / project notes for why this tradeoff is acceptable here.

alter table leagues enable row level security;
alter table teams enable row level security;
alter table fixtures enable row level security;
alter table results enable row level security;
alter table keepalive enable row level security;

create policy "public read/write" on leagues for all using (true) with check (true);
create policy "public read/write" on teams for all using (true) with check (true);
create policy "public read/write" on fixtures for all using (true) with check (true);
create policy "public read/write" on results for all using (true) with check (true);
create policy "public read/write" on keepalive for all using (true) with check (true);
