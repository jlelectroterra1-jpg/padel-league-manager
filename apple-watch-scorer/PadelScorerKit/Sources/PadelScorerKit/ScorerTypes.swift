import Foundation

/// Which side of the match - mirrors the 'A'/'B' strings used throughout
/// the web Scorer Lab's scorer-engine.js, so a state/event dump can be
/// compared directly between the two implementations.
public enum Team: String, Codable, Equatable, Hashable, Sendable {
    case a = "A"
    case b = "B"

    public var opponent: Team { self == .a ? .b : .a }
}

/// Walks forward through the current game only: .points (0/15/30/40) ->
/// .deuce -> .advantage -> .golden. Reset to .points whenever a game is
/// won. There is only ever ONE advantage opportunity per deuce - losing it
/// goes straight to .golden, never back to .deuce (this club's rule; see
/// ScorerEngine.reduce).
public enum GamePhase: String, Codable, Equatable, Sendable {
    case points
    case deuce
    case advantage
    case golden
}

/// A simple per-team integer pair - raw points, games, or tiebreak points,
/// depending on where it's used.
public struct ScoreCount: Codable, Equatable, Sendable {
    public var a: Int
    public var b: Int

    public init(a: Int = 0, b: Int = 0) {
        self.a = a
        self.b = b
    }

    public subscript(team: Team) -> Int {
        get { team == .a ? a : b }
        set {
            if team == .a { a = newValue } else { b = newValue }
        }
    }
}

/// One completed set's final games score, plus its tiebreak score if the
/// set was decided by one (nil otherwise).
public struct SetResult: Codable, Equatable, Sendable {
    public var games: ScoreCount
    public var tiebreak: ScoreCount?
    public var winner: Team

    public init(games: ScoreCount, tiebreak: ScoreCount?, winner: Team) {
        self.games = games
        self.tiebreak = tiebreak
        self.winner = winner
    }
}

/// The full state of a live match - the same shape computeState() returns
/// in scorer-engine.js, field for field, so the two implementations stay
/// directly comparable. Never constructed by hand outside ScorerEngine;
/// always produced by replaying a `[Team]` event list from scratch (see
/// ScorerEngine.computeState) - this is what makes Undo trivially correct
/// on the watch exactly the same way it is on the web: drop the last event
/// and recompute, rather than hand-reversing counters.
public struct MatchState: Codable, Equatable, Sendable {
    public var sets: [SetResult] = []
    public var games: ScoreCount = ScoreCount()
    public var points: ScoreCount = ScoreCount()
    public var gamePhase: GamePhase = .points
    public var advantageTeam: Team?
    public var tiebreak: ScoreCount?
    public var tiebreakFirstServer: Team?
    public var setsWon: ScoreCount = ScoreCount()
    public var winner: Team?
    public var server: Team
    public var matchFirstServer: Team
    public var gamesPlayedTotal: Int = 0

    public init(server: Team) {
        self.server = server
        self.matchFirstServer = server
    }
}
