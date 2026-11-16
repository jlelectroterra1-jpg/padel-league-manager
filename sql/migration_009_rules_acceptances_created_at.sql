-- Fixes migration_008 for any database that already ran its first version,
-- which named the acceptance timestamp accepted_at. db.js orders every list
-- by created_at and stamps it on every insert, so rules_acceptances needs a
-- created_at column or every query on it fails. Renaming (rather than adding
-- a second column) keeps one clear "time of acceptance" field; the table is
-- brand new so nothing is lost. Safe to run more than once, and a no-op on
-- a database built from the corrected migration_008.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'rules_acceptances' and column_name = 'accepted_at'
  ) then
    alter table rules_acceptances rename column accepted_at to created_at;
  end if;
end $$;
