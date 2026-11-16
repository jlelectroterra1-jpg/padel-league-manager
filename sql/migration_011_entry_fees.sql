-- Team entry fees (step 2 of pay-to-play). Additive: new nullable columns, one
-- new table, one view. A league with entry_fee_cents null (every existing
-- league) behaves exactly as it does today - no payment screen anywhere.
-- Requires migration_010 (payments tables) and migration_005 (is_owner()).

-- The organiser's price per team, in cents (the 20% platform fee is added on
-- top by the payment function, never stored here), and the last day a team
-- can pay. null / 0 = a free league.
alter table leagues add column if not exists entry_fee_cents int check (entry_fee_cents is null or entry_fee_cents >= 0);
alter table leagues add column if not exists payment_deadline date;

-- Each payment records how it splits, so payouts are exact whatever the fee
-- later becomes: amount_cents (what the team paid) = fee_cents (the
-- organiser's share) + platform_cents (the 20%). null for test payments.
alter table payments add column if not exists fee_cents int;
alter table payments add column if not exists platform_cents int;

-- 'refunded' = the organiser refunded the team and the Owner repaid them
-- (marked by the Owner by hand).
alter table payments drop constraint if exists payments_status_check;
alter table payments add constraint payments_status_check
  check (status in ('pending', 'complete', 'failed', 'cancelled', 'refunded'));

-- A team can only ever have one live entry payment (a pending one is reused
-- by the function if the team comes back to pay). Closes any double-click /
-- two-phones race at the database level.
create unique index if not exists payments_one_live_team_entry
  on payments(team_id)
  where purpose = 'team_entry' and status in ('pending', 'complete');

-- What a team link and the organiser's Teams tab are allowed to see: only
-- whether a team has paid. No amounts, no PayFast references. A view owned by
-- the table owner reads past payments' own owner-only rule on purpose; it
-- exposes just these columns.
create or replace view team_payment_status as
  select id, created_at, league_id, team_id, status
  from payments
  where purpose = 'team_entry' and team_id is not null;

grant select on team_payment_status to anon, authenticated;

-- The Owner marks a completed payment refunded (and nothing else: the check
-- stops this being used to change amounts or invent a 'complete').
create policy "owner marks payments refunded" on payments
  for update
  using (is_owner() and status = 'complete')
  with check (is_owner() and status = 'refunded');

-- Money the Owner has paid out to an organiser, one row per payout. Owner
-- only, read and write.
create table if not exists payouts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  league_id uuid references leagues(id) on delete set null,
  amount_cents int not null check (amount_cents > 0),
  note text
);

create index if not exists payouts_league_id_idx on payouts(league_id);

alter table payouts enable row level security;
create policy "owner manages payouts" on payouts
  for all
  using (is_owner())
  with check (is_owner());
