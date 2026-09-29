// Pure live-scoring engine for Scorer Lab (owner.html only) - no DOM, no
// fetch, no Supabase. Same "pure logic module" shape as fixtures.js/
// standings.js/playoffs.js, so it can be unit-tested directly in Node.
//
// Event-sourced by design: the only thing ever stored is an ordered list of
// point-winner events ('A' or 'B'). computeState() always replays the whole
// list from scratch - this is what makes Undo trivially correct at ANY
// transition (a popped game/set/tiebreak/match-winning point just isn't
// there when you recompute, rather than needing hand-written "reverse a
// game win" logic that would be easy to get subtly wrong).
//
// Scoring mode is intentionally not a parameter yet - Traditional
// Advantage is the only mode this version implements - but every rule
// lives in its own small pure function (gameWinner/tiebreakWinner) so a
// future Golden Point mode is a second implementation of the same shape,
// not a rewrite of reduce()/computeState().
(function (root) {
  function otherTeam(team) {
    return team === "A" ? "B" : "A";
  }

  // One formula covers plain points AND deuce/advantage: a team wins a
  // game once it has at least 4 raw points AND leads by at least 2 - e.g.
  // 4-0/4-1/4-2 win outright, 4-3 is "advantage" (not yet a win), 5-3 wins
  // from there, 4-4 falls back to "deuce" (not a win). No separate
  // deuce/advantage branch needed - see pointLabel() for how this raw
  // count is turned into "0/15/30/40/AD" for display.
  function gameWinner(points) {
    if (points.A >= 4 && points.A - points.B >= 2) return "A";
    if (points.B >= 4 && points.B - points.A >= 2) return "B";
    return null;
  }

  // Same shape, tiebreak threshold: first to >=7 with a >=2 lead (7-4/8-6/
  // 9-7 win; 7-6 does not).
  function tiebreakWinner(tb) {
    if (tb.A >= 7 && tb.A - tb.B >= 2) return "A";
    if (tb.B >= 7 && tb.B - tb.A >= 2) return "B";
    return null;
  }

  // Whoever serves the very next normal game is whoever didn't serve the
  // last one - alternates every game regardless of who won it.
  function nextGameServer(state) {
    return state.gamesPlayedTotal % 2 === 0 ? state.matchFirstServer : otherTeam(state.matchFirstServer);
  }

  // Standard tennis/padel tiebreak rotation, kept deliberately simple per
  // the brief ("main priority is correct point/game/set scoring"): the
  // first tiebreak point is served by whoever was "due" to serve the next
  // game; after that, service alternates every 2 points.
  function tiebreakServer(pointIndex, firstServer) {
    if (pointIndex === 0) return firstServer;
    const block = Math.floor((pointIndex - 1) / 2);
    return block % 2 === 0 ? otherTeam(firstServer) : firstServer;
  }

  function initialState(initialServer) {
    return {
      sets: [],
      games: { A: 0, B: 0 },
      points: { A: 0, B: 0 },
      tiebreak: null,
      tiebreakFirstServer: null,
      setsWon: { A: 0, B: 0 },
      winner: null,
      server: initialServer,
      matchFirstServer: initialServer,
      gamesPlayedTotal: 0
    };
  }

  // Applies ONE point event to a state, returning a brand-new state -
  // never mutates its input. This is the entire scoring engine; everything
  // else is either a pure helper it calls or computeState() replaying it.
  function reduce(state, team) {
    if (state.winner) return state; // match already decided - ignore further taps

    const next = {
      ...state,
      sets: state.sets.slice(),
      games: { ...state.games },
      points: { ...state.points },
      setsWon: { ...state.setsWon },
      tiebreak: state.tiebreak ? { ...state.tiebreak } : null
    };

    if (next.tiebreak) {
      next.tiebreak[team]++;
      const tbWinner = tiebreakWinner(next.tiebreak);
      if (tbWinner) {
        next.games[tbWinner]++;
        next.sets.push({ games: { ...next.games }, tiebreak: { ...next.tiebreak }, winner: tbWinner });
        next.setsWon[tbWinner]++;
        next.games = { A: 0, B: 0 };
        next.tiebreak = null;
        next.tiebreakFirstServer = null;
        next.points = { A: 0, B: 0 };
        next.gamesPlayedTotal++;
        if (next.setsWon[tbWinner] >= 2) next.winner = tbWinner;
      }
    } else {
      next.points[team]++;
      const gWinner = gameWinner(next.points);
      if (gWinner) {
        next.games[gWinner]++;
        next.points = { A: 0, B: 0 };
        next.gamesPlayedTotal++;
        if (next.games.A === 6 && next.games.B === 6) {
          next.tiebreak = { A: 0, B: 0 };
          next.tiebreakFirstServer = nextGameServer(next);
        } else {
          const setWinner = next.games.A >= 6 && next.games.A - next.games.B >= 2 ? "A" : next.games.B >= 6 && next.games.B - next.games.A >= 2 ? "B" : null;
          if (setWinner) {
            next.sets.push({ games: { ...next.games }, tiebreak: null, winner: setWinner });
            next.setsWon[setWinner]++;
            next.games = { A: 0, B: 0 };
            if (next.setsWon[setWinner] >= 2) next.winner = setWinner;
          }
        }
      }
    }

    // Recompute whose turn to serve for the NEW current point, from
    // scratch, the same way everything else here is recomputed rather than
    // incrementally tracked.
    if (next.tiebreak) {
      const tbPointsPlayed = next.tiebreak.A + next.tiebreak.B;
      next.server = tiebreakServer(tbPointsPlayed, next.tiebreakFirstServer);
    } else {
      next.server = nextGameServer(next);
    }

    return next;
  }

  function computeState(initialServer, events) {
    return events.reduce((state, ev) => reduce(state, ev), initialState(initialServer));
  }

  // Display labels for the current game's points (or the tiebreak's raw
  // numeric score, when one is active).
  function pointLabel(points, tiebreak) {
    if (tiebreak) return { A: String(tiebreak.A), B: String(tiebreak.B) };
    const labels = ["0", "15", "30", "40"];
    const { A, B } = points;
    if (A >= 3 && B >= 3) {
      if (A === B) return { A: "40", B: "40" };
      return A > B ? { A: "AD", B: "40" } : { A: "40", B: "AD" };
    }
    return { A: labels[Math.min(A, 3)], B: labels[Math.min(B, 3)] };
  }

  const ScorerEngine = { computeState, pointLabel, otherTeam };
  if (typeof module !== "undefined" && module.exports) module.exports = ScorerEngine;
  else root.ScorerEngine = ScorerEngine;
})(typeof window !== "undefined" ? window : globalThis);
