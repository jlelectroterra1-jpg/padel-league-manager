-- Adds a forfeit result type, additive only. Existing rows all get
-- result_type='played' via the column default - correct for every result
-- ever recorded so far. Set-score columns were already made nullable by
-- migration_003 (see its own comment), so no change needed there - a
-- forfeit result simply omits them.

alter table results add column if not exists result_type text not null default 'played' check (result_type in ('played', 'forfeit'));
alter table results add column if not exists forfeiting_team_id uuid references teams(id) on delete set null;
