// Pure playoff bracket construction - no fetch, no DOM.
//
// Standard seeding generalizes to any power-of-two bracket size via
// seedPairs' doubling recursion. A configured playoff_size that isn't a
// power of two (or exceeds how many teams qualify) rounds DOWN to the
// nearest supported size - seeding tables aren't well-defined otherwise, and
// this keeps behaviour predictable rather than inventing bye rules nobody
// asked for.
(function (root) {
  function seedPairs(size) {
    let seeds = [1, 2];
    while (seeds.length < size) {
      const s = seeds.length * 2 + 1;
      seeds = seeds.flatMap((x) => [x, s - x]);
    }
    return seeds;
  }

  function nearestBracketSize(n) {
    const sizes = [2, 4, 8, 16];
    let best = 0;
    for (const s of sizes) if (s <= n) best = s;
    return best; // 0 if fewer than 2 teams available
  }

  const STAGE_FOR_SIZE = { 8: "QF", 4: "SF", 2: "F" };
  const NEXT_STAGE_FOR_SIZE = { 8: "SF", 4: "F" };

  // qualifiers: standings rows ordered best-first (see standings.js), each
  // with a `.team.id`. Returns plain fixture-shaped objects - round 1 has
  // both teams filled in, later rounds start with team1_id/team2_id null and
  // a next_bracket_slot pointer for the round before it to fill in once
  // inserted (bracket_slot strings only resolve to real fixture ids after
  // the caller inserts these into the database).
  function buildBracket(qualifiers, requestedSize) {
    const size = nearestBracketSize(Math.min(requestedSize, qualifiers.length));
    if (!size) return [];
    const order = seedPairs(size);
    const firstStage = STAGE_FOR_SIZE[size];

    const round1 = [];
    for (let i = 0; i < size; i += 2) {
      round1.push({
        stage: firstStage,
        bracket_slot: `${firstStage}${round1.length + 1}`,
        team1_id: qualifiers[order[i] - 1].team.id,
        team2_id: qualifiers[order[i + 1] - 1].team.id,
        status: "scheduled"
      });
    }

    const fixtures = [...round1];
    let currentRound = round1;
    let currentSize = size;
    while (currentSize > 2) {
      const nextStage = NEXT_STAGE_FOR_SIZE[currentSize];
      const nextRound = [];
      for (let i = 0; i < currentRound.length; i += 2) {
        nextRound.push({
          stage: nextStage,
          bracket_slot: `${nextStage}${nextRound.length + 1}`,
          team1_id: null,
          team2_id: null,
          status: "scheduled"
        });
      }
      currentRound.forEach((match, i) => {
        match.next_bracket_slot = nextRound[Math.floor(i / 2)].bracket_slot;
        match.next_slot = (i % 2) + 1;
      });
      fixtures.push(...nextRound);
      currentRound = nextRound;
      currentSize /= 2;
    }
    return fixtures;
  }

  const STAGE_ORDER = ["QF", "SF", "F"];

  const Playoffs = { seedPairs, nearestBracketSize, buildBracket, STAGE_ORDER };
  if (typeof module !== "undefined" && module.exports) module.exports = Playoffs;
  else root.Playoffs = Playoffs;
})(typeof window !== "undefined" ? window : globalThis);
