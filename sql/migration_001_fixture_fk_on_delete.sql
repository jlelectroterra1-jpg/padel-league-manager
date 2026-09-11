-- Fixes fixtures.next_fixture_id to SET NULL on delete instead of blocking it.
-- Without this, deleting a fixture that another fixture points to (e.g. a
-- playoff bracket's Final, which earlier semi-finals point to) fails with a
-- foreign key conflict - discovered when archiving/cleaning up a completed
-- playoff bracket. Safe to run once; finds the constraint by its actual
-- relationship rather than assuming a specific name.
do $$
declare
  cname text;
begin
  select conname into cname
  from pg_constraint
  where conrelid = 'public.fixtures'::regclass
    and confrelid = 'public.fixtures'::regclass
    and contype = 'f';
  if cname is not null then
    execute format('alter table fixtures drop constraint %I', cname);
  end if;
end $$;

alter table fixtures
  add constraint fixtures_next_fixture_id_fkey
  foreign key (next_fixture_id) references fixtures(id) on delete set null;
