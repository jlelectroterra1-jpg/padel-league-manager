// Pure standings computation - no fetch, no DOM. Always recomputed from
// confirmed, non-superseded results; never stored as running totals, so a
// corrected result (see results.js) automatically produces correct standings
// on the next render with no separate "recalculate" step.
//
// Scoring: every match is 3 sets. Each set a team wins is worth 1 league
// point, so a team's total points ARE its total sets won across all played
// matches - there's no separate configurable win/draw/loss points system.
// A match is a win for whichever team takes at least 2 of the 3 sets; there
// are no draws.
(function (root) {
  // Defensive dedup: under correct app usage there's at most one
  // non-superseded confirmed result per fixture, but this guards standings
  // against ever double-counting a fixture if that invariant is ever broken
  // (e.g. two admin actions racing) by keeping only the most recently
  // created confirmed row per fixture_id.
  function latestConfirmedByFixture(results) {
    const map = new Map();
    results
      .filter((r) => r.confirmation_status === "confirmed" && !r.superseded)
      .forEach((r) => {
        const existing = map.get(r.fixture_id);
        if (!existing || new Date(r.created_at) > new Date(existing.created_at)) map.set(r.fixture_id, r);
      });
    return map;
  }

  // Counts sets won per team from a result's 3 set scores. A tied set score
  // shouldn't happen (score entry rejects ties), but counts for neither side
  // if it ever does rather than throwing.
  function setsWon(result) {
    const sets = [
      [result.set1_team1_score, result.set1_team2_score],
      [result.set2_team1_score, result.set2_team2_score],
      [result.set3_team1_score, result.set3_team2_score]
    ];
    let team1 = 0;
    let team2 = 0;
    sets.forEach(([a, b]) => {
      if (a == null || b == null) return;
      if (a > b) team1++;
      else if (b > a) team2++;
    });
    return { team1, team2 };
  }

  function computeStandings(teams, fixtures, results) {
    const table = {};
    teams.forEach((t) => {
      table[t.id] = { team: t, played: 0, won: 0, lost: 0, setsWon: 0, setsLost: 0, pts: 0 };
    });

    const fixtureById = Object.fromEntries(fixtures.map((f) => [f.id, f]));
    latestConfirmedByFixture(results).forEach((r) => {
      const fx = fixtureById[r.fixture_id];
      if (!fx || fx.stage !== "league") return;
      const t1 = table[fx.team1_id];
      const t2 = table[fx.team2_id];
      if (!t1 || !t2) return;

      const sw = setsWon(r);
      t1.played++;
      t2.played++;
      t1.setsWon += sw.team1;
      t1.setsLost += sw.team2;
      t2.setsWon += sw.team2;
      t2.setsLost += sw.team1;
      t1.pts += sw.team1;
      t2.pts += sw.team2;

      if (sw.team1 >= 2) {
        t1.won++;
        t2.lost++;
      } else if (sw.team2 >= 2) {
        t2.won++;
        t1.lost++;
      }
    });

    const rows = Object.values(table).map((row) => ({ ...row, diff: row.setsWon - row.setsLost }));
    rows.sort((a, b) => b.pts - a.pts || b.diff - a.diff || b.setsWon - a.setsWon || a.team.name.localeCompare(b.team.name));
    rows.forEach((row, i) => (row.position = i + 1));
    return rows;
  }

  const Standings = { computeStandings, setsWon };
  if (typeof module !== "undefined" && module.exports) module.exports = Standings;
  else root.Standings = Standings;
})(typeof window !== "undefined" ? window : globalThis);
