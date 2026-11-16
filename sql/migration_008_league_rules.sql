-- League rules + team acceptance. Additive only: one new nullable column and
-- one new table. A league with rules = null (every existing league) behaves
-- exactly as it does today - no rules screen, nothing else changes.

-- The league's rules: { config, items }. `config` is the editor state (which
-- optional rules are on, filled-in blanks, custom lines) so the rules can be
-- re-edited until a team accepts them; `items` is the FINAL rendered text
-- list, [{ key, locked, text }], which is what teams actually read and
-- accept. See league-rules.js.
alter table leagues add column if not exists rules jsonb;

-- One row per team that has accepted its league's rules. rules_snapshot is an
-- exact copy of the text the team accepted, so it stays provable even if the
-- league's rules are ever changed afterward. accepted_name is whoever typed
-- their name on the team link (one teammate accepts for the pair). One
-- acceptance per team. created_at is the time of acceptance - it has to be
-- called created_at (not accepted_at): db.js orders every list by
-- created_at and stamps it on every insert, so every table needs one.
create table if not exists rules_acceptances (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade unique,
  accepted_name text not null,
  rules_snapshot jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists rules_acceptances_league_id_idx on rules_acceptances(league_id);

-- Same trust model as every other table the team link uses (leagues, teams,
-- fixtures, results, availability): enabled but permissive, since team links
-- have no login. See schema.sql for the full explanation.
alter table rules_acceptances enable row level security;
create policy "public read/write" on rules_acceptances for all using (true) with check (true);
