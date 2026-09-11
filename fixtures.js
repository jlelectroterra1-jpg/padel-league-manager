// Pure scheduling logic - no fetch, no DOM. Safe to test directly in Node.
//
// generateRoundRobin(teamIds, numCourts) produces one round (week) per team
// minus one (plus one bye round if the team count is odd), guaranteeing every
// team plays every other team exactly once and never plays twice in the same
// week. Matches within a week are spread across the configured court count,
// spilling into extra time slots when there are more matches than courts.
(function (root) {
  const BYE = null;

  function generateRoundRobin(teamIds, numCourts) {
    if (teamIds.length < 2) return [];
    let arr = teamIds.slice();
    if (arr.length % 2 === 1) arr.push(BYE);
    const n = arr.length;
    const fixtures = [];

    for (let round = 0; round < n - 1; round++) {
      const week = round + 1;
      const pairs = [[arr[0], arr[n - 1]]];
      for (let i = 1; i < n / 2; i++) pairs.push([arr[i], arr[n - 1 - i]]);

      const realPairs = pairs.filter(([a, b]) => a !== BYE && b !== BYE);
      const byePairs = pairs.filter(([a, b]) => a === BYE || b === BYE);

      realPairs.forEach(([a, b], i) => {
        const court = (i % numCourts) + 1;
        const timeSlot = Math.floor(i / numCourts) + 1;
        fixtures.push({
          week,
          court,
          time_slot: timeSlot,
          team1_id: a,
          team2_id: b,
          stage: "league",
          status: "scheduled"
        });
      });

      byePairs.forEach(([a, b]) => {
        const byeTeam = a === BYE ? b : a;
        fixtures.push({
          week,
          court: null,
          time_slot: null,
          team1_id: byeTeam,
          team2_id: null,
          stage: "league",
          status: "bye"
        });
      });

      // Rotate everything but the fixed first element.
      const fixed = arr[0];
      const rest = arr.slice(1);
      rest.unshift(rest.pop());
      arr = [fixed, ...rest];
    }

    return fixtures;
  }

  // Splits a team's league-stage fixtures into opponents already played
  // (confirmed result exists) vs. still to play. confirmedFixtureIds is a
  // Set of fixture ids that have a confirmed, non-superseded result.
  function opponentSplit(teamId, fixtures, confirmedFixtureIds) {
    confirmedFixtureIds = confirmedFixtureIds || new Set();
    const played = [];
    const remaining = [];
    fixtures
      .filter((f) => f.stage === "league" && (f.team1_id === teamId || f.team2_id === teamId))
      .forEach((f) => {
        const oppId = f.team1_id === teamId ? f.team2_id : f.team1_id;
        if (oppId == null) return; // bye week
        (confirmedFixtureIds.has(f.id) ? played : remaining).push({ opponentId: oppId, fixture: f });
      });
    return { played, remaining };
  }

  // The earliest league-stage fixture for a team that doesn't have a
  // confirmed result yet (byes excluded) - used for a dashboard's "next match".
  function nextFixtureForTeam(teamId, fixtures, results) {
    const confirmedIds = new Set(
      results.filter((r) => r.confirmation_status === "confirmed" && !r.superseded).map((r) => r.fixture_id)
    );
    const upcoming = fixtures
      .filter(
        (f) =>
          f.stage === "league" &&
          f.status !== "bye" &&
          (f.team1_id === teamId || f.team2_id === teamId) &&
          !confirmedIds.has(f.id)
      )
      .sort((a, b) => a.week - b.week);
    return upcoming[0] || null;
  }

  const Fixtures = { generateRoundRobin, opponentSplit, nextFixtureForTeam };
  if (typeof module !== "undefined" && module.exports) module.exports = Fixtures;
  else root.Fixtures = Fixtures;
})(typeof window !== "undefined" ? window : globalThis);
