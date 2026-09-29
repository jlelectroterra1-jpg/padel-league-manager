// Write-path orchestration for match results: submit -> confirm/dispute ->
// (if disputed) admin correction. Uses db.js for persistence; no DOM here.
//
// Every match is 3 sets, entered as [set1, set2, set3] score arrays per
// team. Which team "won" a set/match is always derived from those raw
// scores (see standings.js's setsWon) - never stored as a separate flag.
//
// History rule: a result row is NEVER updated to change its score. Correcting
// one (admin_override) marks the old row superseded=true and inserts a new
// confirmed row instead - this is what lets standings always be recomputed
// straight from `results` without ever drifting from the real match history.
(function (root) {
  const { dbInsert, dbUpdate, dbList, dbGet } = window.DB;

  function setColumns(team1Sets, team2Sets) {
    return {
      set1_team1_score: team1Sets[0],
      set1_team2_score: team2Sets[0],
      set2_team1_score: team1Sets[1],
      set2_team2_score: team2Sets[1],
      set3_team1_score: team1Sets[2],
      set3_team2_score: team2Sets[2]
    };
  }

  async function submitResult(fixture, submittingTeamId, mySets, oppSets) {
    const isTeam1 = fixture.team1_id === submittingTeamId;
    const team1Sets = isTeam1 ? mySets : oppSets;
    const team2Sets = isTeam1 ? oppSets : mySets;
    return dbInsert("results", {
      fixture_id: fixture.id,
      ...setColumns(team1Sets, team2Sets),
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
    const fixture = await dbGet("fixtures", result.fixture_id);
    await dbUpdate("fixtures", result.fixture_id, { status: "completed" });
    await afterConfirmed(fixture, saved);
    return saved;
  }

  async function disputeResult(result, reason) {
    return dbUpdate("results", result.id, {
      confirmation_status: "disputed",
      dispute_reason: reason || null,
      disputed_at: new Date().toISOString()
    });
  }

  async function adminSetResult(fixture, oldResult, team1Sets, team2Sets) {
    // Supersede every currently-active result for this fixture, not just the
    // one the caller thinks is active - keeps "at most one live result per
    // fixture" true even if the caller's view of the world was stale.
    const existing = await dbList("results", { fixture_id: `eq.${fixture.id}` });
    for (const r of existing.filter((r) => !r.superseded)) await dbUpdate("results", r.id, { superseded: true });
    const saved = await dbInsert("results", {
      fixture_id: fixture.id,
      ...setColumns(team1Sets, team2Sets),
      submitted_by_team_id: null,
      confirmation_status: "confirmed",
      confirmed_at: new Date().toISOString(),
      admin_override: true,
      superseded: false
    });
    await dbUpdate("fixtures", fixture.id, { status: "completed" });
    await afterConfirmed(fixture, saved);
    return saved;
  }

  // Admin/organiser-only: records that `forfeitingTeamId` forfeited this
  // fixture. No set scores are ever stored for a forfeit - standings.js
  // awards the opponent a flat 2 league points (not derived from sets) and
  // never touches setsWon/setsLost for either team. Same "supersede whatever
  // is currently active" shape as adminSetResult, so at most one live result
  // per fixture holds even if a team had already submitted something.
  async function recordForfeit(fixture, forfeitingTeamId) {
    const existing = await dbList("results", { fixture_id: `eq.${fixture.id}` });
    for (const r of existing.filter((r) => !r.superseded)) await dbUpdate("results", r.id, { superseded: true });
    const saved = await dbInsert("results", {
      fixture_id: fixture.id,
      result_type: "forfeit",
      forfeiting_team_id: forfeitingTeamId,
      submitted_by_team_id: null,
      confirmation_status: "confirmed",
      confirmed_at: new Date().toISOString(),
      admin_override: true,
      superseded: false
    });
    await dbUpdate("fixtures", fixture.id, { status: "completed" });
    await afterConfirmed(fixture, saved);
    return saved;
  }

  // Reverses a forfeit entered by mistake: supersedes its result row (no
  // replacement inserted) and puts the fixture back to its normal
  // not-yet-played state - since standings.js always recomputes from
  // scratch off non-superseded confirmed results, this alone is enough to
  // correctly undo the +1 played / +1 won-or-lost / 2 pts, no manual
  // reversal math needed. Doesn't un-advance a playoff winner who already
  // moved on to the next round - same pre-existing limitation "correct
  // score" has always had for playoffs, not something forfeit introduces.
  async function undoForfeit(result, fixture) {
    await dbUpdate("results", result.id, { superseded: true });
    await dbUpdate("fixtures", fixture.id, { status: "scheduled" });
  }

  // Playoff-only follow-through: once a QF/SF/F result is confirmed, push the
  // winner into whichever fixture/slot it feeds (see playoffs.js for how
  // next_fixture_id/next_slot get set up when the bracket is built), and once
  // the Final itself is confirmed, mark the league complete.
  async function afterConfirmed(fixture, result) {
    if (!fixture || fixture.stage === "league") return;

    if (fixture.next_fixture_id) {
      let winnerId;
      if (result.result_type === "forfeit") {
        winnerId = result.forfeiting_team_id === fixture.team1_id ? fixture.team2_id : fixture.team1_id;
      } else {
        const sw = window.Standings.setsWon(result);
        winnerId = sw.team1 >= 2 ? fixture.team1_id : sw.team2 >= 2 ? fixture.team2_id : null;
      }
      if (winnerId) {
        const patch = fixture.next_slot === 2 ? { team2_id: winnerId } : { team1_id: winnerId };
        await dbUpdate("fixtures", fixture.next_fixture_id, patch);
      }
    }

    if (fixture.stage === "F") {
      await dbUpdate("leagues", fixture.league_id, { status: "completed" });
    }
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

  const Results = { submitResult, confirmResult, disputeResult, adminSetResult, recordForfeit, undoForfeit, activeResultForFixture };
  if (typeof module !== "undefined" && module.exports) module.exports = Results;
  else root.Results = Results;
})(typeof window !== "undefined" ? window : globalThis);
