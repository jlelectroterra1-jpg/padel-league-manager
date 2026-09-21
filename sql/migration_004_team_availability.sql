-- Adds the Team Availability feature: a per-league ON/OFF switch and a new
-- `availability` table (one row per team per week). Safe to run once against
-- the live project - purely additive, nothing existing is touched.

alter table leagues add column if not exists availability_enabled boolean not null default true;

create table if not exists availability (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  week_start date not null,
  slots jsonb not null default '[]',
  note text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (team_id, week_start)
);

create index if not exists availability_league_id_idx on availability(league_id);
create index if not exists availability_team_week_idx on availability(team_id, week_start);

alter table availability enable row level security;

drop policy if exists "public read/write" on availability;
create policy "public read/write" on availability for all using (true) with check (true);
