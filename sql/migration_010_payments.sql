-- Payments (step 1 of pay-to-play): the tables the PayFast Edge Function
-- writes to. Additive only - two new tables, nothing existing is touched.
--
-- Nothing in the browser can create or change a payment: no insert/update/
-- delete policies exist for anyone, so only the Edge Function (which uses the
-- service-role key and bypasses RLS) can write. A payment only ever becomes
-- 'complete' when PayFast's confirmation (ITN) passes every check in
-- supabase/functions/payfast/index.ts.

-- One row per payment attempt. Amounts are integer cents. created_at is
-- required on every table (db.js orders by it and stamps it on inserts).
create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  purpose text not null check (purpose in ('test', 'team_entry', 'league_activation')),
  status text not null default 'pending' check (status in ('pending', 'complete', 'failed', 'cancelled')),
  amount_cents int not null check (amount_cents > 0),
  league_id uuid references leagues(id) on delete set null,
  team_id uuid references teams(id) on delete set null,
  pf_payment_id text,
  created_by uuid
);

create index if not exists payments_status_idx on payments(status);
create index if not exists payments_team_id_idx on payments(team_id);

-- Audit log of every notification PayFast sends us, including rejected ones.
-- Kept apart from `payments` on purpose: a notification can contain the
-- buyer's name and email, and `payments` will later be readable from team
-- links. This table has NO policies, so nobody can read it through the API -
-- only the service role (the Edge Function, or you in the SQL editor).
create table if not exists payment_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  payment_id uuid references payments(id) on delete cascade,
  outcome text not null,
  payload jsonb
);

create index if not exists payment_events_payment_id_idx on payment_events(payment_id);

alter table payments enable row level security;
alter table payment_events enable row level security;

-- For now only the Owner can read payments (the Payments Lab tab). Public
-- read of a team's own paid status is added later, when the team link needs
-- it. is_owner() comes from migration_005.
create policy "owner reads payments" on payments
  for select
  using (is_owner());
