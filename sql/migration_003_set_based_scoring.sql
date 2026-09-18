-- Switches league scoring from configurable win/draw/loss points to a fixed
-- 3-sets-per-match system where each set won = 1 league point.
--
-- IMPORTANT: this can't preserve old results' scores. The old schema stored
-- one number per team per match (e.g. "6-4"); the new one stores 3 separate
-- set scores. There's no way to reconstruct 3 sets from a single old score,
-- so any match confirmed BEFORE this migration will show no score/sets
-- afterward - the fixture and its confirmation history stay, just the score
-- itself is gone. Re-enter those results if you need them under the new
-- system.
--
-- The new set columns are left nullable here (rather than NOT NULL as in a
-- fresh sql/schema.sql install) specifically so this ALTER doesn't fail
-- against whatever existing rows are already in the table.

alter table results add column if not exists set1_team1_score int;
alter table results add column if not exists set1_team2_score int;
alter table results add column if not exists set2_team1_score int;
alter table results add column if not exists set2_team2_score int;
alter table results add column if not exists set3_team1_score int;
alter table results add column if not exists set3_team2_score int;

alter table results drop column if exists team1_score;
alter table results drop column if exists team2_score;

alter table leagues drop column if exists scoring_config;
