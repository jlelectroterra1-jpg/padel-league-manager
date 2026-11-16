-- Self-serve organisers + R50 league activation (step 3 of pay-to-play).
-- Requires migration_005 (organisers, is_owner), 007 (league_admins),
-- 010 (payments) and 011.
--
-- What changes:
--  * New organisers are active at once (paying R50 per league is the filter);
--    any still-pending organiser is activated. The Owner can still suspend.
--  * Only the Owner can insert into `leagues` directly. Everyone else creates
--    a league through create_league(), which ALWAYS marks it as needing the
--    R50 activation - so creating a league can't skip the R50.
--  * A league "needs activation" iff it has a row in league_activations. It is
--    "paid" iff a completed league_activation payment exists - and payments
--    can only be written by the payment function after PayFast confirms. The
--    4 existing leagues have no row, so they are untouched and never asked to
--    pay.
-- Updating / deleting / reading leagues stays open exactly as before, so every
-- existing admin console and team link keeps working.
--
-- To undo the leagues lock: drop the four policies created below and run
--   create policy "public read/write" on leagues for all using (true) with check (true);

-- ---------- accounts: active on sign-up ----------

drop policy if exists "self-register as pending organiser" on organisers;
drop policy if exists "self-register as organiser" on organisers;
create policy "self-register as organiser" on organisers
  for insert
  with check (auth.uid() = id and role = 'organiser' and status = 'active');

update organisers set status = 'active' where role = 'organiser' and status = 'pending';

-- ---------- which leagues need to pay ----------

create table if not exists league_activations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  league_id uuid not null unique references leagues(id) on delete cascade
);

-- No policies on purpose: nobody can read or write this table through the
-- API. Rows are created only by create_league() below.
alter table league_activations enable row level security;

-- One live (pending or complete) activation payment per league, so a double
-- tap can never create two.
create unique index if not exists payments_one_live_league_activation
  on payments(league_id)
  where purpose = 'league_activation' and status in ('pending', 'complete');

-- What team links, My Leagues and the admin console may see: whether a league
-- that needs activating has been paid for. Nothing else.
create or replace view league_activation_status as
  select a.id, a.created_at, a.league_id,
    exists (
      select 1 from payments p
      where p.league_id = a.league_id and p.purpose = 'league_activation' and p.status = 'complete'
    ) as paid
  from league_activations a;

grant select on league_activation_status to anon, authenticated;

-- ---------- league creation ----------

drop policy if exists "public read/write" on leagues;
drop policy if exists "public read" on leagues;
drop policy if exists "public update" on leagues;
drop policy if exists "public delete" on leagues;
drop policy if exists "owner inserts leagues" on leagues;

create policy "public read" on leagues for select using (true);
create policy "public update" on leagues for update using (true) with check (true);
create policy "public delete" on leagues for delete using (true);
create policy "owner inserts leagues" on leagues for insert with check (is_owner());

-- The one way for a signed-in organiser to create a league. Runs with the
-- function owner's rights (so it can write the tables the caller can't), but
-- only for an active organiser/owner, and only these league fields.
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
begin
  select * into caller from organisers where id = auth.uid();
  if not found or caller.status <> 'active' then
    raise exception 'You need an active organiser account to create a league.' using errcode = '42501';
  end if;

  if btrim(coalesce(p->>'name', '')) = '' then
    raise exception 'League name is required.' using errcode = '22023';
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
                       entry_fee_cents, payment_deadline, rules)
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
    case when jsonb_typeof(p->'rules') = 'object' then p->'rules' end
  )
  returning * into new_league;

  -- Organisers' leagues must be activated (R50); an Owner-created league is free.
  needs_activation := caller.role = 'organiser';
  if needs_activation then
    insert into league_admins (league_id, organiser_id, role) values (new_league.id, caller.id, 'admin');
    insert into league_activations (league_id) values (new_league.id);
  end if;

  return jsonb_build_object('id', new_league.id, 'needs_activation', needs_activation);
end;
$$;

revoke all on function create_league(jsonb) from public;
revoke execute on function create_league(jsonb) from anon;
grant execute on function create_league(jsonb) to authenticated;
