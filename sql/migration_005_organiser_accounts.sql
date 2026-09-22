-- Adds Owner/Organiser multi-tenant accounts on top of Supabase Auth.
-- Purely additive: new `organisers` table + new nullable `leagues.organiser_id`
-- column. Every EXISTING table's RLS policy is left completely untouched -
-- admin.html and team.html keep sending the public anon key with no auth
-- session on every request and keep getting exactly the same full
-- read/write access they have today. Safe to run once against the live
-- project; the two existing leagues get organiser_id = NULL ("Unassigned")
-- and are otherwise untouched.

-- One row per Supabase Auth user who is an Owner or League Organiser. id is
-- NOT a separate generated key - it IS auth.users.id, giving the 1:1
-- relationship the multi-organiser design needs. name/email/phone are
-- captured at registration time and stored here (denormalized) because
-- PostgREST only exposes the `public` schema - there is no REST-queryable
-- view of auth.users for the Owner Dashboard to read from.
create table if not exists organisers (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text not null unique,
  phone text,
  role text not null default 'organiser' check (role in ('organiser', 'owner')),
  status text not null default 'pending' check (status in ('pending', 'active', 'suspended')),
  created_at timestamptz not null default now()
);

alter table leagues add column if not exists organiser_id uuid references organisers(id) on delete set null;

create index if not exists organisers_role_idx on organisers(role);
create index if not exists leagues_organiser_id_idx on leagues(organiser_id);

-- security definer so a policy on organisers can check "is the caller an
-- owner" without recursing through that same table's own SELECT policy.
-- Only ever checks auth.uid()'s own row - never widens access.
create or replace function is_owner()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from organisers
    where id = auth.uid() and role = 'owner' and status = 'active'
  );
$$;

grant execute on function is_owner() to authenticated, anon;

alter table organisers enable row level security;

-- Read own profile (needed by login.html/auth.js to resolve role+status);
-- Owner reads everyone's (Owner Dashboard's organiser table).
create policy "read own row or owner reads all" on organisers
  for select
  using (auth.uid() = id or is_owner());

-- Self-registration: exactly one row, for yourself, pinned to
-- organiser/pending regardless of what the client sends - blocks a crafted
-- REST payload from self-granting role='owner' or status='active' at
-- signup time.
create policy "self-register as pending organiser" on organisers
  for insert
  with check (auth.uid() = id and role = 'organiser' and status = 'pending');

-- Only the Owner can approve/suspend/reactivate. No self-service profile
-- edit in Phase 1 - this keeps a non-owner from touching status/role even
-- indirectly via a raw PATCH to /rest/v1/organisers.
create policy "owner updates any organiser" on organisers
  for update
  using (is_owner())
  with check (is_owner());

-- No delete policy in Phase 1. Deleting the underlying auth.users row (if
-- ever needed, from the Supabase dashboard) cascades and removes this row
-- automatically via the FK above.

-- leagues/teams/fixtures/results/availability RLS is deliberately left
-- untouched here. Their existing `for all using (true) with check (true)`
-- policies (see schema.sql) already grant unconditional access to anyone
-- holding the anon key - admin.html and team.html depend on that staying
-- true on every request, forever, since neither page ever establishes an
-- auth session. "My Leagues" scoping is implemented as an ordinary
-- PostgREST query filter (organiser_id=eq.<id>) in my-leagues-view.js
-- instead of a new DB-enforced boundary - a UX convenience consistent with
-- this app's existing documented trust model, not a regression from it.
