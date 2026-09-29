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
// Scoring mode is intentionally not a parameter yet - "deuce, one
// advantage, then golden point" (this club's actual rule - see reduce()'s
// gamePhase state machine) is the only mode this version implements - but
// every rule lives in its own small pure function/branch so a future mode
// (e.g. golden point from 40-40 with no advantage at all) is a variant of
// the same shape, not a rewrite of reduce()/computeState().
(function (root) {
  function otherTeam(team) {
    return team === "A" ? "B" : "A";
  }

  // Win check for the "points" phase ONLY - i.e. before either side has
  // ever reached deuce in this game. A team wins outright once it has at
  // least 4 raw points AND leads by at least 2 (4-0/4-1/4-2 all win). The
  // two counts can only ever become equal at 3-3 (40-40) - points increase
  // one at a time, so there's no way to reach a 4-3 state without passing
  // through 3-3 first - and reduce() switches to the deuce/advantage/
  // golden-point state machine right at that 3-3 moment instead of ever
  // calling this again for the rest of the game.
  function preDeuceGameWinner(points) {
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
      // gamePhase walks forward through "points" -> "deuce" -> "advantage"
      // -> "golden" for the current game only, reset to "points" whenever a
      // game is won. There is only ever ONE advantage opportunity per
      // deuce - if the advantage is lost, gamePhase goes straight to
      // "golden" rather than back to "deuce", per this club's rule.
      gamePhase: "points",
      advantageTeam: null,
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
        next.gamePhase = "points";
        next.advantageTeam = null;
        next.gamesPlayedTotal++;
        if (next.setsWon[tbWinner] >= 2) next.winner = tbWinner;
      }
    } else {
      let gWinner = null;

      if (next.gamePhase === "golden") {
        // Sudden death - whoever wins this point wins the game outright.
        gWinner = team;
      } else if (next.gamePhase === "advantage") {
        if (team === next.advantageTeam) {
          gWinner = team; // held serve on the advantage point -> game
        } else {
          // Lost the advantage point - straight to golden point, NOT back
          // to deuce (only one advantage opportunity per deuce).
          next.gamePhase = "golden";
          next.advantageTeam = null;
        }
      } else if (next.gamePhase === "deuce") {
        next.gamePhase = "advantage";
        next.advantageTeam = team;
      } else {
        next.points[team]++;
        if (next.points.A === 3 && next.points.B === 3) {
          next.gamePhase = "deuce";
        } else {
          gWinner = preDeuceGameWinner(next.points);
        }
      }

      if (gWinner) {
        next.games[gWinner]++;
        next.points = { A: 0, B: 0 };
        next.gamePhase = "points";
        next.advantageTeam = null;
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

  // Per-side display labels for the current game's points (or the
  // tiebreak's raw numeric score, when one is active). Takes the whole
  // state object since deuce/advantage/golden point are phase-based now,
  // not derivable from raw point counts alone.
  function pointLabel(state) {
    if (state.tiebreak) return { A: String(state.tiebreak.A), B: String(state.tiebreak.B) };
    if (state.gamePhase === "golden") return { A: "GP", B: "GP" };
    if (state.gamePhase === "advantage") return state.advantageTeam === "A" ? { A: "AD", B: "40" } : { A: "40", B: "AD" };
    if (state.gamePhase === "deuce") return { A: "40", B: "40" };
    const labels = ["0", "15", "30", "40"];
    return { A: labels[Math.min(state.points.A, 3)], B: labels[Math.min(state.points.B, 3)] };
  }

  // A human-readable phase name for the banner in the UI - "" when there's
  // nothing special to say (plain points, or mid-tiebreak).
  function gamePhaseLabel(state) {
    if (state.tiebreak) return "";
    if (state.gamePhase === "deuce") return "Deuce";
    if (state.gamePhase === "advantage") return "Advantage";
    if (state.gamePhase === "golden") return "Golden Point";
    return "";
  }

  const ScorerEngine = { computeState, pointLabel, gamePhaseLabel, otherTeam };
  if (typeof module !== "undefined" && module.exports) module.exports = ScorerEngine;
  else root.ScorerEngine = ScorerEngine;
})(typeof window !== "undefined" ? window : globalThis);
