-- Admin lockdown: organisers can only change the leagues they administer.
-- Requires migration_005 (organisers, is_owner), 007 (league_admins) and 012
-- (leagues policies).
--
-- Until now the leagues, teams and fixtures tables were open to anyone holding
-- the public key, so any organiser (or anyone at all) could edit or delete any
-- league. After this:
--   * teams:    anyone can READ (team links need it); only that league's
--               admins (or the Owner) can add, edit or delete teams.
--   * fixtures: anyone can READ; only admins can add or delete. UPDATE stays
--               open because team links, with no login, mark a fixture
--               completed and move a playoff winner into the next round - but
--               a guard trigger limits everyone except admins to exactly those
--               two things.
--   * leagues:  anyone can READ; only admins can delete. UPDATE stays open only
--               because a team link marks the league 'completed' when the Final
--               is confirmed - the guard trigger limits non-admins to exactly
--               that.
-- Results, availability and rules acceptances stay open on purpose (team links
-- have no login and must keep working). The Owner counts as an admin of every
-- league; a suspended organiser is an admin of nothing.
--
-- The guard triggers only apply to requests coming through the API as anon or
-- authenticated users, so the SQL editor and the payment function (service
-- role) are never blocked by them.
--
-- To undo: drop the policies and triggers created below and run, for each of
-- teams, fixtures and leagues:
--   create policy "public read/write" on <table> for all using (true) with check (true);

-- ---------- who is an admin of a league ----------

create or replace function is_league_admin(lid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from organisers o
    where o.id = auth.uid()
      and o.status = 'active'
      and (
        o.role = 'owner'
        or exists (select 1 from league_admins a where a.league_id = lid and a.organiser_id = o.id)
      )
  );
$$;

grant execute on function is_league_admin(uuid) to anon, authenticated;

-- ---------- teams ----------

drop policy if exists "public read/write" on teams;
drop policy if exists "public read" on teams;
drop policy if exists "admins insert teams" on teams;
drop policy if exists "admins update teams" on teams;
drop policy if exists "admins delete teams" on teams;

create policy "public read" on teams for select using (true);
create policy "admins insert teams" on teams for insert with check (is_league_admin(league_id));
create policy "admins update teams" on teams for update using (is_league_admin(league_id)) with check (is_league_admin(league_id));
create policy "admins delete teams" on teams for delete using (is_league_admin(league_id));

-- ---------- fixtures ----------

drop policy if exists "public read/write" on fixtures;
drop policy if exists "public read" on fixtures;
drop policy if exists "admins insert fixtures" on fixtures;
drop policy if exists "public update fixtures" on fixtures;
drop policy if exists "admins delete fixtures" on fixtures;

create policy "public read" on fixtures for select using (true);
create policy "admins insert fixtures" on fixtures for insert with check (is_league_admin(league_id));
create policy "public update fixtures" on fixtures for update using (true) with check (true);
create policy "admins delete fixtures" on fixtures for delete using (is_league_admin(league_id));

-- Non-admins (team links) may only: switch a fixture between scheduled and
-- completed, and put a team of the SAME league into an empty playoff slot.
create or replace function guard_fixture_update()
returns trigger
language plpgsql
as $$
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') or is_league_admin(old.league_id) then
    return new;
  end if;

  if (to_jsonb(old) - 'status' - 'team1_id' - 'team2_id') <> (to_jsonb(new) - 'status' - 'team1_id' - 'team2_id') then
    raise exception 'Only the league organiser can change this fixture.' using errcode = '42501';
  end if;

  if new.status is distinct from old.status
     and not (old.status in ('scheduled', 'completed') and new.status in ('scheduled', 'completed')) then
    raise exception 'Only the league organiser can change this fixture.' using errcode = '42501';
  end if;

  if new.team1_id is distinct from old.team1_id
     and (old.team1_id is not null
          or not exists (select 1 from teams t where t.id = new.team1_id and t.league_id = old.league_id)) then
    raise exception 'Only the league organiser can change this fixture.' using errcode = '42501';
  end if;

  if new.team2_id is distinct from old.team2_id
     and (old.team2_id is not null
          or not exists (select 1 from teams t where t.id = new.team2_id and t.league_id = old.league_id)) then
    raise exception 'Only the league organiser can change this fixture.' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_fixture_update on fixtures;
create trigger guard_fixture_update before update on fixtures
  for each row execute function guard_fixture_update();

-- ---------- leagues ----------

drop policy if exists "public delete" on leagues;
drop policy if exists "admins delete leagues" on leagues;
create policy "admins delete leagues" on leagues for delete using (is_league_admin(id));

-- "public update" (from migration_012) stays; the trigger narrows it.
create or replace function guard_league_update()
returns trigger
language plpgsql
as $$
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') or is_league_admin(old.id) then
    return new;
  end if;

  -- Team links only ever mark a league completed (when the Final is confirmed).
  if (to_jsonb(old) - 'status') <> (to_jsonb(new) - 'status') or new.status <> 'completed' then
    raise exception 'Only the league organiser can change this league.' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_league_update on leagues;
create trigger guard_league_update before update on leagues
  for each row execute function guard_league_update();
