import Foundation

/// Pure live-scoring engine - the Swift equivalent of the web app's
/// scorer-engine.js (padel-league-manager/scorer-engine.js is the
/// reference implementation; keep this file's rules in sync with it by
/// hand, and use ScorerEngineTests.swift / the JS engine's own test suite
/// to catch drift). No I/O, no WatchConnectivity, no UI - just data in,
/// data out - so this is the one place the watch, phone, or a future
/// Wear OS (Kotlin) port needs to implement these rules; nothing here is
/// duplicated in WatchApp/PhoneApp, which only ever call into this.
///
/// Event-sourced by design, exactly like the web version: the only thing
/// ever stored is an ordered list of point-winner events. computeState()
/// always replays the whole list from scratch - this is what makes Undo
/// trivially correct at ANY transition (a popped game/set/tiebreak/
/// match-winning point just isn't there when you recompute), with zero
/// hand-written "reverse a score" logic anywhere.
public enum ScorerEngine {

    /// Win check for the "points" phase ONLY - i.e. before either side has
    /// ever reached deuce in this game. A team wins outright once it has
    /// at least 4 raw points AND leads by at least 2 (4-0/4-1/4-2 all
    /// win). The two counts can only ever become equal at 3-3 (40-40) -
    /// points increase one at a time - and reduce() switches to the
    /// deuce/advantage/golden-point state machine right at that 3-3
    /// moment instead of ever calling this again for the rest of the game.
    private static func preDeuceGameWinner(_ points: ScoreCount) -> Team? {
        if points.a >= 4 && points.a - points.b >= 2 { return .a }
        if points.b >= 4 && points.b - points.a >= 2 { return .b }
        return nil
    }

    /// Same shape, tiebreak threshold: first to >=7 with a >=2 lead
    /// (7-4/8-6/9-7 win; 7-6 does not).
    private static func tiebreakWinner(_ tb: ScoreCount) -> Team? {
        if tb.a >= 7 && tb.a - tb.b >= 2 { return .a }
        if tb.b >= 7 && tb.b - tb.a >= 2 { return .b }
        return nil
    }

    /// Whoever serves the very next normal game is whoever didn't serve
    /// the last one - alternates every game regardless of who won it.
    private static func nextGameServer(_ state: MatchState) -> Team {
        state.gamesPlayedTotal % 2 == 0 ? state.matchFirstServer : state.matchFirstServer.opponent
    }

    /// Standard tennis/padel tiebreak rotation, kept deliberately simple
    /// (main priority is correct point/game/set scoring): the first
    /// tiebreak point is served by whoever was "due" to serve the next
    /// game; after that, service alternates every 2 points.
    private static func tiebreakServer(pointIndex: Int, firstServer: Team) -> Team {
        if pointIndex == 0 { return firstServer }
        let block = (pointIndex - 1) / 2
        return block % 2 == 0 ? firstServer.opponent : firstServer
    }

    public static func initialState(initialServer: Team) -> MatchState {
        MatchState(server: initialServer)
    }

    /// Applies ONE point event to a state, returning a brand-new state -
    /// never mutates its input. This is the entire scoring engine;
    /// everything else is either a pure helper it calls or computeState()
    /// replaying it.
    public static func reduce(_ state: MatchState, _ team: Team) -> MatchState {
        if state.winner != nil { return state } // match already decided - ignore further taps

        var next = state

        if var tiebreak = next.tiebreak {
            tiebreak[team] += 1
            next.tiebreak = tiebreak
            if let tbWinner = tiebreakWinner(tiebreak) {
                next.games[tbWinner] += 1
                next.sets.append(SetResult(games: next.games, tiebreak: tiebreak, winner: tbWinner))
                next.setsWon[tbWinner] += 1
                next.games = ScoreCount()
                next.tiebreak = nil
                next.tiebreakFirstServer = nil
                next.points = ScoreCount()
                next.gamePhase = .points
                next.advantageTeam = nil
                next.gamesPlayedTotal += 1
                if next.setsWon[tbWinner] >= 2 { next.winner = tbWinner }
            }
        } else {
            var gWinner: Team?

            switch next.gamePhase {
            case .golden:
                // Sudden death - whoever wins this point wins the game outright.
                gWinner = team
            case .advantage:
                if team == next.advantageTeam {
                    gWinner = team // held the advantage point -> game
                } else {
                    // Lost the advantage point - straight to golden point,
                    // NOT back to deuce (only one advantage opportunity
                    // per deuce).
                    next.gamePhase = .golden
                    next.advantageTeam = nil
                }
            case .deuce:
                next.gamePhase = .advantage
                next.advantageTeam = team
            case .points:
                next.points[team] += 1
                if next.points.a == 3 && next.points.b == 3 {
                    next.gamePhase = .deuce
                } else {
                    gWinner = preDeuceGameWinner(next.points)
                }
            }

            if let gWinner {
                next.games[gWinner] += 1
                next.points = ScoreCount()
                next.gamePhase = .points
                next.advantageTeam = nil
                next.gamesPlayedTotal += 1
                if next.games.a == 6 && next.games.b == 6 {
                    next.tiebreak = ScoreCount()
                    next.tiebreakFirstServer = nextGameServer(next)
                } else {
                    let setWinner: Team? =
                        (next.games.a >= 6 && next.games.a - next.games.b >= 2) ? .a :
                        (next.games.b >= 6 && next.games.b - next.games.a >= 2) ? .b : nil
                    if let setWinner {
                        next.sets.append(SetResult(games: next.games, tiebreak: nil, winner: setWinner))
                        next.setsWon[setWinner] += 1
                        next.games = ScoreCount()
                        if next.setsWon[setWinner] >= 2 { next.winner = setWinner }
                    }
                }
            }
        }

        // Recompute whose turn to serve for the NEW current point, from
        // scratch, the same way everything else here is recomputed rather
        // than incrementally tracked.
        if let tiebreak = next.tiebreak {
            let tbPointsPlayed = tiebreak.a + tiebreak.b
            next.server = tiebreakServer(pointIndex: tbPointsPlayed, firstServer: next.tiebreakFirstServer ?? next.server)
        } else {
            next.server = nextGameServer(next)
        }

        return next
    }

    public static func computeState(initialServer: Team, events: [Team]) -> MatchState {
        events.reduce(initialState(initialServer: initialServer)) { reduce($0, $1) }
    }

    /// Per-side display labels for the current game's points (or the
    /// tiebreak's raw numeric score, when one is active).
    public static func pointLabel(_ state: MatchState) -> (a: String, b: String) {
        if let tb = state.tiebreak { return (String(tb.a), String(tb.b)) }
        if state.gamePhase == .golden { return ("GP", "GP") }
        if state.gamePhase == .advantage {
            return state.advantageTeam == .a ? ("AD", "40") : ("40", "AD")
        }
        if state.gamePhase == .deuce { return ("40", "40") }
        let labels = ["0", "15", "30", "40"]
        return (labels[min(state.points.a, 3)], labels[min(state.points.b, 3)])
    }

    /// A human-readable phase name - "" when there's nothing special to
    /// say (plain points, or mid-tiebreak; the caller decides whether to
    /// show "Tiebreak" itself, same as the web's scorer-lab-view.js does
    /// in its specialStateLabel()).
    public static func gamePhaseLabel(_ state: MatchState) -> String {
        if state.tiebreak != nil { return "" }
        switch state.gamePhase {
        case .deuce: return "Deuce"
        case .advantage: return "Advantage"
        case .golden: return "Golden Point"
        case .points: return ""
        }
    }

    /// Would `team` win the match if they won the very next point?
    /// Answered by literally asking the engine - simulate that one extra
    /// event and see whether it decides the match - rather than
    /// hand-deriving "is this a match point" a second time. Matches the
    /// web's ScorerLab.wouldWinMatch exactly.
    public static func wouldWinMatch(events: [Team], initialServer: Team, team: Team) -> Bool {
        let hypothetical = computeState(initialServer: initialServer, events: events + [team])
        return hypothetical.winner == team
    }
}
