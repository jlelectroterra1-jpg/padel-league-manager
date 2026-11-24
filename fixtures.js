// Pure scheduling logic - no fetch, no DOM. Safe to test directly in Node.
//
// generateRoundRobin(teamIds, numCourts, weeks) builds a full round robin:
// every team plays every other team exactly once, and never plays twice in
// the same round. There is one round per team minus one (plus one bye round
// if the team count is odd).
//
// By default each round is its own week. Pass `weeks` (fewer than the number
// of rounds) to squeeze the rounds into that many weeks, so some or all teams
// play two (or more) matches in a week - e.g. 12 teams have 11 rounds, and 6
// weeks means two matches a week. Everyone still plays everyone once.
//
// Matches within a week are spread across the configured court count,
// spilling into extra time slots when there are more matches than courts. A
// round never shares a time slot with another round in the same week, so a
// team's two matches in a week are never at the same time.
(function (root) {
  const BYE = null;

  // The most matches a team may be asked to play in one week.
  const MAX_MATCHES_PER_WEEK = 3;

  // How many rounds a full round robin has for this many teams.
  function roundCount(teamCount) {
    if (teamCount < 2) return 0;
    return (teamCount % 2 === 1 ? teamCount + 1 : teamCount) - 1;
  }

  // The weeks an organiser can pick: `max` is one round a week (the default),
  // `min` is the fewest that keeps everyone to MAX_MATCHES_PER_WEEK or less.
  function weekRange(teamCount) {
    const rounds = roundCount(teamCount);
    return { rounds, min: Math.max(1, Math.ceil(rounds / MAX_MATCHES_PER_WEEK)), max: rounds };
  }

  function generateRoundRobin(teamIds, numCourts, weeks) {
    if (teamIds.length < 2) return [];
    numCourts = numCourts || 1;
    let arr = teamIds.slice();
    if (arr.length % 2 === 1) arr.push(BYE);
    const n = arr.length;
    const rounds = [];

    for (let round = 0; round < n - 1; round++) {
      const pairs = [[arr[0], arr[n - 1]]];
      for (let i = 1; i < n / 2; i++) pairs.push([arr[i], arr[n - 1 - i]]);

      rounds.push({
        realPairs: pairs.filter(([a, b]) => a !== BYE && b !== BYE),
        byeTeams: pairs.filter(([a, b]) => a === BYE || b === BYE).map(([a, b]) => (a === BYE ? b : a))
      });

      // Rotate everything but the fixed first element.
      const fixed = arr[0];
      const rest = arr.slice(1);
      rest.unshift(rest.pop());
      arr = [fixed, ...rest];
    }

    const totalRounds = rounds.length;
    const weekCount = weeks >= 1 && weeks < totalRounds ? Math.floor(weeks) : totalRounds;
    const weekOfRound = (r) => Math.floor((r * weekCount) / totalRounds) + 1;
    const fixtures = [];

    for (let week = 1; week <= weekCount; week++) {
      const inWeek = rounds.filter((_, r) => weekOfRound(r) === week);
      const playing = new Set();
      let slotOffset = 0;

      inWeek.forEach(({ realPairs }) => {
        realPairs.forEach(([a, b], i) => {
          playing.add(a);
          playing.add(b);
          fixtures.push({
            week,
            court: (i % numCourts) + 1,
            time_slot: slotOffset + Math.floor(i / numCourts) + 1,
            team1_id: a,
            team2_id: b,
            stage: "league",
            status: "scheduled"
          });
        });
        slotOffset += Math.ceil(realPairs.length / numCourts);
      });

      // A bye only shows in a week where that team has no match at all.
      inWeek.forEach(({ byeTeams }) => {
        byeTeams.forEach((team) => {
          if (playing.has(team)) return;
          fixtures.push({
            week,
            court: null,
            time_slot: null,
            team1_id: team,
            team2_id: null,
            stage: "league",
            status: "bye"
          });
        });
      });
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
      .sort(byPlayOrder);
    return upcoming[0] || null;
  }

  // Week first, then (for a team with two matches in a week) the earlier slot.
  function byPlayOrder(a, b) {
    return a.week - b.week || (a.time_slot || 0) - (b.time_slot || 0) || (a.court || 0) - (b.court || 0);
  }

  const Fixtures = { generateRoundRobin, roundCount, weekRange, MAX_MATCHES_PER_WEEK, byPlayOrder, opponentSplit, nextFixtureForTeam };
  if (typeof module !== "undefined" && module.exports) module.exports = Fixtures;
  else root.Fixtures = Fixtures;
})(typeof window !== "undefined" ? window : globalThis);
