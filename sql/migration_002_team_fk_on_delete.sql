-- Fixes fixtures.team1_id/team2_id and results.submitted_by_team_id/
-- confirmed_by_team_id to SET NULL on delete instead of blocking it.
-- Same class of issue as migration 001 (next_fixture_id): once a team has
-- any fixtures generated - which is true for almost every team in a running
-- league - deleting it outright hit a foreign key conflict with no clear
-- error shown to the user. The app itself now blocks deleting a team that
-- already has fixtures (pointing you at "Mark inactive" instead, since
-- removing one team's matches would leave holes in everyone else's
-- schedule), but this migration is a defense-in-depth fix for the database
-- layer too, so the same class of silent failure can't resurface some other
-- way. Safe to run once; finds each constraint by its actual relationship
-- rather than assuming a specific name.
do $$
declare
  rec record;
begin
  for rec in
    select conname, conrelid::regclass::text as tbl
    from pg_constraint
    where contype = 'f'
      and confrelid = 'public.teams'::regclass
      and conrelid in ('public.fixtures'::regclass, 'public.results'::regclass)
  loop
    execute format('alter table %s drop constraint %I', rec.tbl, rec.conname);
  end loop;
end $$;

alter table fixtures
  add constraint fixtures_team1_id_fkey foreign key (team1_id) references teams(id) on delete set null,
  add constraint fixtures_team2_id_fkey foreign key (team2_id) references teams(id) on delete set null;

alter table results
  add constraint results_submitted_by_team_id_fkey foreign key (submitted_by_team_id) references teams(id) on delete set null,
  add constraint results_confirmed_by_team_id_fkey foreign key (confirmed_by_team_id) references teams(id) on delete set null;
