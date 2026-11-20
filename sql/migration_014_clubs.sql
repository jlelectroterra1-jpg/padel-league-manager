-- Migration 014: clubs.
--
-- A club (e.g. "Padel Up") is a venue that subscribes monthly and runs as many
-- leagues (and, later, events) as it likes. Club members are ordinary
-- organiser accounts linked to the club with a role:
--   admin - runs everything in the club and adds/removes staff
--   staff - runs everything in the club
-- Every club member counts as an admin of every league that belongs to the
-- club (is_league_admin() below), so the existing league console (admin.html)
-- works for them unchanged. Club leagues never need the R50 activation.
--
-- Solo organisers and their leagues are untouched: a league with no club_id
-- behaves exactly as before.
--
-- Run once in the Supabase SQL editor, after migration_013.

-- ---------- tables ----------

create table if not exists clubs (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null,
  status text not null default 'active' check (status in ('pending', 'active', 'suspended')),
  created_at timestamptz not null default now()
);

create table if not exists club_members (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  organiser_id uuid not null references organisers(id) on delete cascade,
  role text not null default 'staff' check (role in ('admin', 'staff')),
  created_at timestamptz not null default now(),
  unique (club_id, organiser_id)
);

create index if not exists club_members_club_id_idx on club_members(club_id);
create index if not exists club_members_organiser_id_idx on club_members(organiser_id);

alter table leagues add column if not exists club_id uuid references clubs(id) on delete set null;
create index if not exists leagues_club_id_idx on leagues(club_id);

-- ---------- helper functions ----------

-- Is the signed-in user an active member of this (active) club?
create or replace function is_club_member(cid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from club_members m
    join organisers o on o.id = m.organiser_id
    join clubs c on c.id = m.club_id
    where m.club_id = cid
      and m.organiser_id = auth.uid()
      and o.status = 'active'
      and c.status = 'active'
  );
$$;
grant execute on function is_club_member(uuid) to anon, authenticated;

-- ...and a club admin specifically (can manage staff).
create or replace function is_club_admin(cid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select is_owner() or exists (
    select 1
    from club_members m
    join organisers o on o.id = m.organiser_id
    where m.club_id = cid
      and m.organiser_id = auth.uid()
      and m.role = 'admin'
      and o.status = 'active'
  );
$$;
grant execute on function is_club_admin(uuid) to anon, authenticated;

-- League admins now also include every member of the league's club.
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
  )
  or exists (
    select 1 from leagues l where l.id = lid and l.club_id is not null and is_club_member(l.club_id)
  );
$$;
grant execute on function is_league_admin(uuid) to anon, authenticated;

-- ---------- row level security ----------

alter table clubs enable row level security;
alter table club_members enable row level security;

-- The club link page shows the club's name before anyone logs in.
drop policy if exists "public read" on clubs;
create policy "public read" on clubs for select using (true);
drop policy if exists "owner manages clubs" on clubs;
create policy "owner manages clubs" on clubs for all using (is_owner()) with check (is_owner());

-- Members see their own club's member list; the owner sees all.
drop policy if exists "members read club members" on club_members;
create policy "members read club members" on club_members for select
  using (organiser_id = auth.uid() or is_club_member(club_id) or is_owner());
drop policy if exists "club admins remove members" on club_members;
create policy "club admins remove members" on club_members for delete
  using (is_club_admin(club_id) and organiser_id <> auth.uid());
-- Adding a member goes through add_club_member() below (it has to look the
-- person up by email, which RLS on organisers rightly hides).

-- Club members need to see the names of the people in their club.
drop policy if exists "club members read each other" on organisers;
create policy "club members read each other" on organisers for select
  using (exists (
    select 1 from club_members mine
    join club_members theirs on theirs.club_id = mine.club_id
    where mine.organiser_id = auth.uid() and theirs.organiser_id = organisers.id
  ));

-- ---------- functions the app calls ----------

-- Owner: create a club and make an existing organiser account its admin.
-- The admin must have registered first (register.html); their account is
-- activated automatically.
create or replace function create_club(p_name text, p_slug text, p_admin_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  new_club clubs%rowtype;
  admin_id uuid;
begin
  if not is_owner() then
    raise exception 'Only the owner can create clubs.' using errcode = '42501';
  end if;
  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'Club name is required.' using errcode = '22023';
  end if;
  if coalesce(p_slug, '') !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'The club link can only use lowercase letters, numbers and dashes (e.g. padel-up).' using errcode = '22023';
  end if;
  if exists (select 1 from clubs where slug = p_slug) then
    raise exception 'That club link is already taken.' using errcode = '23505';
  end if;
  select id into admin_id from organisers where lower(email) = lower(btrim(p_admin_email));
  if admin_id is null then
    raise exception 'No account uses that email yet - ask them to sign up first, then try again.' using errcode = '22023';
  end if;

  insert into clubs (name, slug) values (btrim(p_name), p_slug) returning * into new_club;
  insert into club_members (club_id, organiser_id, role) values (new_club.id, admin_id, 'admin');
  update organisers set status = 'active' where id = admin_id and status = 'pending';

  return jsonb_build_object('id', new_club.id, 'slug', new_club.slug);
end;
$$;
revoke all on function create_club(text, text, text) from public;
grant execute on function create_club(text, text, text) to authenticated;

-- Club admin: add someone (who has signed up) to the club as staff or admin.
create or replace function add_club_member(p_club_id uuid, p_email text, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  member_id uuid;
begin
  if not is_club_admin(p_club_id) then
    raise exception 'Only a club admin can add people.' using errcode = '42501';
  end if;
  if coalesce(p_role, '') not in ('admin', 'staff') then
    raise exception 'Role must be admin or staff.' using errcode = '22023';
  end if;
  select id into member_id from organisers where lower(email) = lower(btrim(p_email));
  if member_id is null then
    raise exception 'No account uses that email yet - ask them to sign up first, then add them again.' using errcode = '22023';
  end if;

  insert into club_members (club_id, organiser_id, role) values (p_club_id, member_id, p_role)
  on conflict (club_id, organiser_id) do update set role = excluded.role;
  -- Joining an active club activates the account - no separate owner approval.
  update organisers set status = 'active' where id = member_id and status = 'pending';

  return jsonb_build_object('organiser_id', member_id);
end;
$$;
revoke all on function add_club_member(uuid, text, text) from public;
grant execute on function add_club_member(uuid, text, text) to authenticated;

-- create_league: same as migration_012, plus an optional club_id. A club
-- league needs the caller to be a member of that (active) club, and never
-- needs the R50 activation - the club's subscription covers it.
create or replace function create_league(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  caller organisers%rowtype;
  fee int;
  new_league leagues%rowtype;
  needs_activation boolean;
  cid uuid;
begin
  select * into caller from organisers where id = auth.uid();
  if not found or caller.status <> 'active' then
    raise exception 'You need an active organiser account to create a league.' using errcode = '42501';
  end if;

  if btrim(coalesce(p->>'name', '')) = '' then
    raise exception 'League name is required.' using errcode = '22023';
  end if;

  cid := nullif(p->>'club_id', '')::uuid;
  if cid is not null and caller.role <> 'owner' and not is_club_member(cid) then
    raise exception 'You are not a member of that club.' using errcode = '42501';
  end if;

  fee := nullif(p->>'entry_fee_cents', '')::int;
  if fee is not null and fee <> 0 then
    if fee < 500 or fee > 500000 then
      raise exception 'The entry fee must be between R5.00 and R5000.00.' using errcode = '22023';
    end if;
    if nullif(p->>'payment_deadline', '') is null then
      raise exception 'A payment cut-off date is required when there is an entry fee.' using errcode = '22023';
    end if;
  end if;

  insert into leagues (name, description, start_date, num_teams, num_courts, playoff_size, status,
                       entry_fee_cents, payment_deadline, rules, club_id)
  values (
    btrim(p->>'name'),
    nullif(p->>'description', ''),
    nullif(p->>'start_date', '')::date,
    nullif(p->>'num_teams', '')::int,
    coalesce(nullif(p->>'num_courts', '')::int, 1),
    coalesce(nullif(p->>'playoff_size', '')::int, 8),
    'draft',
    case when fee > 0 then fee end,
    case when fee > 0 then (p->>'payment_deadline')::date end,
    case when jsonb_typeof(p->'rules') = 'object' then p->'rules' end,
    cid
  )
  returning * into new_league;

  -- A club league is run through club membership (is_league_admin), not a
  -- personal admin row, so removing someone from the club - or pausing the
  -- club - really does take away their access to its leagues.
  if caller.role = 'organiser' and cid is null then
    insert into league_admins (league_id, organiser_id, role) values (new_league.id, caller.id, 'admin');
  end if;

  -- Solo organisers' leagues must be activated (R50); club and Owner leagues are free.
  needs_activation := caller.role = 'organiser' and cid is null;
  if needs_activation then
    insert into league_activations (league_id) values (new_league.id);
  end if;

  return jsonb_build_object('id', new_league.id, 'needs_activation', needs_activation);
end;
$$;

revoke all on function create_league(jsonb) from public;
revoke execute on function create_league(jsonb) from anon;
grant execute on function create_league(jsonb) to authenticated;
