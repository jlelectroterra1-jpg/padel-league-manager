-- Many-to-many organiser <-> league assignment, replacing the Phase 1
-- single leagues.organiser_id column for anything new. That column is left
-- in place untouched (existing data preserved, nothing destructive) - it's
-- simply no longer read or written by app code after this migration; every
-- existing assignment is copied into the new table below instead.

create table if not exists league_admins (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  organiser_id uuid not null references organisers(id) on delete cascade,
  -- Free text, no fixed set yet - Phase 1 only ever writes/reads 'admin'
  -- (every assigned organiser has identical access), but the column exists
  -- now so a future phase can introduce e.g. primary/co-admin/read-only
  -- without another migration to add it.
  role text not null default 'admin',
  created_at timestamptz not null default now(),
  unique (league_id, organiser_id)
);

create index if not exists league_admins_league_id_idx on league_admins(league_id);
create index if not exists league_admins_organiser_id_idx on league_admins(organiser_id);

-- Backfill: every league that currently has a single organiser_id gets a
-- matching league_admins row, preserving existing access exactly.
-- Idempotent (safe to re-run) via ON CONFLICT.
insert into league_admins (league_id, organiser_id, role)
select id, organiser_id, 'admin' from leagues
where organiser_id is not null
on conflict (league_id, organiser_id) do nothing;

alter table league_admins enable row level security;

-- Real enforcement (new table, nothing depends on it being open, same
-- reasoning as the `organisers` table in migration_005): an organiser can
-- read their own assignment rows; the Owner reads everything.
create policy "read own admin rows or owner reads all" on league_admins
  for select
  using (organiser_id = auth.uid() or is_owner());

-- Only the Owner adds or removes an admin assignment.
create policy "owner adds admin assignments" on league_admins
  for insert
  with check (is_owner());

create policy "owner removes admin assignments" on league_admins
  for delete
  using (is_owner());

-- leagues/teams/fixtures/results/availability RLS is deliberately left
-- untouched here, same reasoning as migration_005: admin.html and
-- team.html depend on those tables staying fully open to the anon key on
-- every request, forever. "My Leagues" scoping now goes through a real,
-- RLS-backed two-step lookup (league_admins filtered by the caller's own
-- auth.uid(), then leagues by id) in my-leagues-view.js, rather than a
-- client-side filter over a full fetch - a genuine access boundary for the
-- listing itself, not just UI-hiding. Real per-league gating of admin.html
-- (teams/fixtures/results) remains the same deliberately deferred future
-- phase flagged after the Phase 1 rollout.
