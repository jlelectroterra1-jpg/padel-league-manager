// Pure standings computation - no fetch, no DOM. Always recomputed from
// confirmed, non-superseded results; never stored as running totals, so a
// corrected result (see results.js) automatically produces correct standings
// on the next render with no separate "recalculate" step.
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

  function computeStandings(teams, fixtures, results, scoringConfig) {
    const cfg = Object.assign({ win: 3, draw: 1, loss: 0 }, scoringConfig || {});
    const table = {};
    teams.forEach((t) => {
      table[t.id] = { team: t, played: 0, won: 0, lost: 0, drawn: 0, pf: 0, pa: 0, pts: 0 };
    });

    const fixtureById = Object.fromEntries(fixtures.map((f) => [f.id, f]));
    latestConfirmedByFixture(results).forEach((r) => {
      const fx = fixtureById[r.fixture_id];
      if (!fx || fx.stage !== "league") return;
      const t1 = table[fx.team1_id];
      const t2 = table[fx.team2_id];
      if (!t1 || !t2) return;

      t1.played++;
      t2.played++;
      t1.pf += r.team1_score;
      t1.pa += r.team2_score;
      t2.pf += r.team2_score;
      t2.pa += r.team1_score;

      if (r.team1_score > r.team2_score) {
        t1.won++;
        t1.pts += cfg.win;
        t2.lost++;
        t2.pts += cfg.loss;
      } else if (r.team2_score > r.team1_score) {
        t2.won++;
        t2.pts += cfg.win;
        t1.lost++;
        t1.pts += cfg.loss;
      } else {
        t1.drawn++;
        t2.drawn++;
        t1.pts += cfg.draw;
        t2.pts += cfg.draw;
      }
    });

    const rows = Object.values(table).map((row) => ({ ...row, diff: row.pf - row.pa }));
    rows.sort((a, b) => b.pts - a.pts || b.diff - a.diff || b.pf - a.pf || a.team.name.localeCompare(b.team.name));
    rows.forEach((row, i) => (row.position = i + 1));
    return rows;
  }

  const Standings = { computeStandings };
  if (typeof module !== "undefined" && module.exports) module.exports = Standings;
  else root.Standings = Standings;
})(typeof window !== "undefined" ? window : globalThis);
