// Write-path orchestration for match results: submit -> confirm/dispute ->
// (if disputed) admin correction. Uses db.js for persistence; no DOM here.
//
// History rule: a result row is NEVER updated to change its score. Correcting
// one (admin_override) marks the old row superseded=true and inserts a new
// confirmed row instead - this is what lets standings always be recomputed
// straight from `results` without ever drifting from the real match history.
(function (root) {
  const { dbInsert, dbUpdate, dbList } = window.DB;

  async function submitResult(fixture, submittingTeamId, myScore, oppScore) {
    const isTeam1 = fixture.team1_id === submittingTeamId;
    const team1_score = isTeam1 ? myScore : oppScore;
    const team2_score = isTeam1 ? oppScore : myScore;
    return dbInsert("results", {
      fixture_id: fixture.id,
      team1_score,
      team2_score,
      submitted_by_team_id: submittingTeamId,
      confirmation_status: "pending",
      admin_override: false,
      superseded: false
    });
  }

  async function confirmResult(result, confirmingTeamId) {
    const saved = await dbUpdate("results", result.id, {
      confirmation_status: "confirmed",
      confirmed_by_team_id: confirmingTeamId,
      confirmed_at: new Date().toISOString()
    });
    await dbUpdate("fixtures", result.fixture_id, { status: "completed" });
    return saved;
  }

  async function disputeResult(result, reason) {
    return dbUpdate("results", result.id, {
      confirmation_status: "disputed",
      dispute_reason: reason || null,
      disputed_at: new Date().toISOString()
    });
  }

  async function adminSetResult(fixture, oldResult, team1_score, team2_score) {
    // Supersede every currently-active result for this fixture, not just the
    // one the caller thinks is active - keeps "at most one live result per
    // fixture" true even if the caller's view of the world was stale.
    const existing = await dbList("results", { fixture_id: `eq.${fixture.id}` });
    for (const r of existing.filter((r) => !r.superseded)) await dbUpdate("results", r.id, { superseded: true });
    const saved = await dbInsert("results", {
      fixture_id: fixture.id,
      team1_score,
      team2_score,
      submitted_by_team_id: null,
      confirmation_status: "confirmed",
      confirmed_at: new Date().toISOString(),
      admin_override: true,
      superseded: false
    });
    await dbUpdate("fixtures", fixture.id, { status: "completed" });
    return saved;
  }

  // The single "live" result for a fixture, if any. Under correct usage
  // there's at most one non-superseded row per fixture, but this picks the
  // most recently created one if that's ever violated, rather than whichever
  // the API happened to return first.
  function activeResultForFixture(fixtureId, allResults) {
    const candidates = allResults.filter((r) => r.fixture_id === fixtureId && !r.superseded);
    if (!candidates.length) return null;
    return candidates.reduce((latest, r) => (new Date(r.created_at) > new Date(latest.created_at) ? r : latest));
  }

  const Results = { submitResult, confirmResult, disputeResult, adminSetResult, activeResultForFixture };
  if (typeof module !== "undefined" && module.exports) module.exports = Results;
  else root.Results = Results;
})(typeof window !== "undefined" ? window : globalThis);
