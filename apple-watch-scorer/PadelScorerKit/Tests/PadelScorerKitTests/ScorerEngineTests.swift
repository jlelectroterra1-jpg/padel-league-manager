import XCTest
@testable import PadelScorerKit

/// Direct port of the web engine's own test suite (see
/// padel-league-manager/scorer-engine.js and the two rounds of Node test
/// scripts used to verify it during development). Run via `swift test`
/// once this package is opened on a Mac - if every case here passes, the
/// watch engine's behaviour matches the web Scorer Lab exactly, which is
/// the whole point of keeping this test file in lockstep with the JS one.
final class ScorerEngineTests: XCTestCase {

    // Builds an event list that wins one game for `winner` from a clean
    // 0-0, same shape as the JS tests' `winGame` helper.
    private func winGame(_ events: [Team], _ winner: Team) -> [Team] {
        events + [winner, winner, winner, winner]
    }

    // MARK: - 0 -> 15 -> 30 -> 40 -> Game (pre-deuce)

    func testPointProgression() {
        var s = ScorerEngine.computeState(initialServer: .a, events: [])
        XCTAssertEqual(ScorerEngine.pointLabel(s).a, "0")
        XCTAssertEqual(ScorerEngine.pointLabel(s).b, "0")

        s = ScorerEngine.computeState(initialServer: .a, events: [.a])
        XCTAssertEqual(ScorerEngine.pointLabel(s), ("15", "0"))

        s = ScorerEngine.computeState(initialServer: .a, events: [.a, .a, .a])
        XCTAssertEqual(ScorerEngine.pointLabel(s), ("40", "0"))

        s = ScorerEngine.computeState(initialServer: .a, events: [.a, .a, .a, .a])
        XCTAssertEqual(s.games, ScoreCount(a: 1, b: 0), "40-0 + point = game")
    }

    func testOutrightWinWithoutTouchingDeuce() {
        // 40-15 then win = game, without ever entering the deuce machinery.
        let s = ScorerEngine.computeState(initialServer: .a, events: [.a, .a, .a, .b, .a])
        XCTAssertEqual(s.games, ScoreCount(a: 1, b: 0))
        XCTAssertEqual(s.gamePhase, .points)
    }

    // MARK: - Deuce -> Advantage -> Game (holds the advantage)

    func testDeuceThenAdvantageThenGame() {
        var events: [Team] = [.a, .b, .a, .b, .a, .b] // 3-3 = deuce
        var s = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(s.gamePhase, .deuce)
        XCTAssertEqual(ScorerEngine.pointLabel(s), ("40", "40"))
        XCTAssertEqual(ScorerEngine.gamePhaseLabel(s), "Deuce")

        events.append(.a) // advantage A
        s = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(s.gamePhase, .advantage)
        XCTAssertEqual(s.advantageTeam, .a)
        XCTAssertEqual(ScorerEngine.pointLabel(s), ("AD", "40"))
        XCTAssertEqual(s.games, ScoreCount(a: 0, b: 0), "advantage is not a game win yet")

        events.append(.a) // A holds -> game A
        s = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(s.games, ScoreCount(a: 1, b: 0))
        XCTAssertEqual(s.gamePhase, .points, "resets after game")
        XCTAssertEqual(s.points, ScoreCount())
    }

    // MARK: - Deuce -> Advantage LOST -> Golden Point (not back to deuce)

    func testAdvantageLostGoesToGoldenPointNotDeuce() {
        var events: [Team] = [.a, .b, .a, .b, .a, .b, .a] // deuce, advantage A
        var s = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(s.gamePhase, .advantage)

        events.append(.b) // B wins the advantage point -> GOLDEN POINT, not deuce
        s = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(s.gamePhase, .golden)
        XCTAssertNil(s.advantageTeam)
        XCTAssertEqual(s.games, ScoreCount())
        XCTAssertEqual(ScorerEngine.pointLabel(s), ("GP", "GP"))
        XCTAssertEqual(ScorerEngine.gamePhaseLabel(s), "Golden Point")

        // From golden point, A wins -> game A
        let winA = ScorerEngine.computeState(initialServer: .a, events: events + [.a])
        XCTAssertEqual(winA.games, ScoreCount(a: 1, b: 0))
        XCTAssertEqual(winA.gamePhase, .points)

        // From golden point, B wins -> game B (the brief's exact worked example)
        let winB = ScorerEngine.computeState(initialServer: .a, events: events + [.b])
        XCTAssertEqual(winB.games, ScoreCount(a: 0, b: 1))
    }

    func testSecondWorkedExampleFromBrief() {
        // Deuce -> advantage B -> B holds -> game B.
        let events: [Team] = [.a, .b, .a, .b, .a, .b, .b, .b]
        let s = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(s.games, ScoreCount(a: 0, b: 1))
    }

    func testOnlyOneAdvantageOpportunity() {
        // deuce -> advantage A -> lost -> golden point
        let events: [Team] = [.a, .b, .a, .b, .a, .b, .a, .b]
        let s = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(s.gamePhase, .golden, "after losing the one advantage, straight to golden point")

        // Further points while in golden point resolve immediately -
        // never a second deuce/advantage cycle.
        let next = ScorerEngine.computeState(initialServer: .a, events: events + [.a])
        XCTAssertEqual(next.games, ScoreCount(a: 1, b: 0))
    }

    // MARK: - Games progression

    func testGamesProgression() {
        var events = winGame([], .a)
        var s = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(s.games, ScoreCount(a: 1, b: 0))

        events = winGame(events, .a)
        s = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(s.games, ScoreCount(a: 2, b: 0))
    }

    // MARK: - Sets: 6-0, 6-4, 7-5

    func testSetSixLove() {
        var events: [Team] = []
        for _ in 0..<6 { events = winGame(events, .a) }
        let s = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(s.sets, [SetResult(games: ScoreCount(a: 6, b: 0), tiebreak: nil, winner: .a)])
        XCTAssertEqual(s.setsWon, ScoreCount(a: 1, b: 0))
    }

    func testSetSixFour() {
        var events: [Team] = []
        for _ in 0..<4 {
            events = winGame(events, .a)
            events = winGame(events, .b)
        }
        events = winGame(events, .a)
        events = winGame(events, .a)
        let s = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(s.sets.last, SetResult(games: ScoreCount(a: 6, b: 4), tiebreak: nil, winner: .a))
    }

    func testSetSevenFive() {
        var events: [Team] = []
        for _ in 0..<5 {
            events = winGame(events, .a)
            events = winGame(events, .b)
        }
        var mid = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(mid.games, ScoreCount(a: 5, b: 5), "5-5 continues playing")

        events = winGame(events, .a)
        mid = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(mid.games, ScoreCount(a: 6, b: 5))
        XCTAssertEqual(mid.sets.count, 0, "no set decided at 6-5 (only 1 game lead)")

        events = winGame(events, .a)
        let s = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(s.sets.last, SetResult(games: ScoreCount(a: 7, b: 5), tiebreak: nil, winner: .a))
    }

    // MARK: - Tiebreak: 6-6 then tiebreak scoring

    // Reaches a target tiebreak score by strictly alternating points, so
    // neither side ever crosses the winning threshold early (a run of
    // same-team points would trigger a win before the target is reached).
    private func alternateTo(_ start: [Team], _ aCount: Int, _ bCount: Int) -> [Team] {
        var arr = start
        for _ in 0..<min(aCount, bCount) { arr += [.a, .b] }
        if aCount > bCount { arr.append(.a) }
        if bCount > aCount { arr.append(.b) }
        return arr
    }

    func testTiebreakStartsAtSixSix() {
        var events: [Team] = []
        for _ in 0..<6 {
            events = winGame(events, .a)
            events = winGame(events, .b)
        }
        let s = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(s.games, ScoreCount(a: 6, b: 6))
        XCTAssertNotNil(s.tiebreak)
        XCTAssertEqual(s.tiebreak, ScoreCount())
    }

    func testTiebreakSevenFour() {
        var events: [Team] = []
        for _ in 0..<6 {
            events = winGame(events, .a)
            events = winGame(events, .b)
        }
        // A:4, B:0, then B:4 (no premature win, 4 < 7), then A wins 3 more -> 7-4
        events += [.a, .a, .a, .a, .b, .b, .b, .b, .a, .a, .a]
        let s = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(s.sets.last, SetResult(games: ScoreCount(a: 7, b: 6), tiebreak: ScoreCount(a: 7, b: 4), winner: .a))
    }

    func testTiebreakSevenSixIsNotAWin() {
        var events: [Team] = []
        for _ in 0..<6 {
            events = winGame(events, .a)
            events = winGame(events, .b)
        }
        let notYet = alternateTo(events, 7, 6)
        let mid = ScorerEngine.computeState(initialServer: .a, events: notYet)
        XCTAssertNotNil(mid.tiebreak, "7-6 in a tiebreak is NOT a win")
        XCTAssertEqual(mid.tiebreak, ScoreCount(a: 7, b: 6))
    }

    func testTiebreakEightSix() {
        var events: [Team] = []
        for _ in 0..<6 {
            events = winGame(events, .a)
            events = winGame(events, .b)
        }
        let notYet = alternateTo(events, 7, 6)
        let s = ScorerEngine.computeState(initialServer: .a, events: notYet + [.a])
        XCTAssertEqual(s.sets.last?.tiebreak, ScoreCount(a: 8, b: 6))
    }

    func testTiebreakNineSeven() {
        var events: [Team] = []
        for _ in 0..<6 {
            events = winGame(events, .a)
            events = winGame(events, .b)
        }
        let notYet = alternateTo(events, 8, 7)
        let mid = ScorerEngine.computeState(initialServer: .a, events: notYet)
        XCTAssertNotNil(mid.tiebreak, "8-7 is not a win yet")
        XCTAssertEqual(mid.tiebreak, ScoreCount(a: 8, b: 7))

        let s = ScorerEngine.computeState(initialServer: .a, events: notYet + [.a])
        XCTAssertEqual(s.sets.last?.tiebreak, ScoreCount(a: 9, b: 7))
    }

    // MARK: - Match: best of 3, 2 sets wins

    func testMatchCompletionAndPostMatchEventsIgnored() {
        var events: [Team] = []
        for _ in 0..<2 {
            for _ in 0..<6 { events = winGame(events, .a) }
        }
        let s = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(s.setsWon, ScoreCount(a: 2, b: 0))
        XCTAssertEqual(s.winner, .a)

        let extra = ScorerEngine.computeState(initialServer: .a, events: events + [.b, .b, .b, .b])
        XCTAssertEqual(extra.winner, .a, "winner unchanged once the match is already decided")
        XCTAssertEqual(extra.setsWon, ScoreCount(a: 2, b: 0))
    }

    // MARK: - Match point

    func testMatchPointDetection() {
        // Set 1 to A (6-0); set 2, A leads 5-0 games, 40-0 in the 6th game
        // - winning the next point wins the game AND the match.
        var events: [Team] = []
        for _ in 0..<6 { events = winGame(events, .a) }
        for _ in 0..<5 { events = winGame(events, .a) }
        events += [.a, .a, .a]

        XCTAssertTrue(ScorerEngine.wouldWinMatch(events: events, initialServer: .a, team: .a))
        XCTAssertFalse(ScorerEngine.wouldWinMatch(events: events, initialServer: .a, team: .b))
    }

    func testNoMatchPointMidDeuceGame() {
        // Deuce itself is never match point - winning the next point only
        // grants advantage, it can't end the game.
        var events: [Team] = []
        for _ in 0..<6 { events = winGame(events, .a) }
        events += [.a, .b, .a, .b, .a, .b] // set 2, 3-3 deuce in game 1
        XCTAssertFalse(ScorerEngine.wouldWinMatch(events: events, initialServer: .a, team: .a))
        XCTAssertFalse(ScorerEngine.wouldWinMatch(events: events, initialServer: .a, team: .b))
    }

    // MARK: - Undo through every important transition

    func testUndoOutOfGameWin() {
        let events: [Team] = [.a, .a, .a, .a] // just won a game
        let before = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(before.games, ScoreCount(a: 1, b: 0))

        let undone = ScorerEngine.computeState(initialServer: .a, events: Array(events.dropLast()))
        XCTAssertEqual(undone.games, ScoreCount())
        XCTAssertEqual(undone.points, ScoreCount(a: 3, b: 0), "back to 40-0")
    }

    func testUndoOutOfSetWin() {
        var events: [Team] = []
        for _ in 0..<6 { events = winGame(events, .a) }
        let before = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(before.sets.count, 1)

        let undone = ScorerEngine.computeState(initialServer: .a, events: Array(events.dropLast()))
        XCTAssertEqual(undone.sets.count, 0)
        XCTAssertEqual(undone.games, ScoreCount(a: 5, b: 0))
        XCTAssertEqual(undone.points, ScoreCount(a: 3, b: 0))
    }

    func testUndoOutOfTiebreakPoint() {
        var events: [Team] = []
        for _ in 0..<6 {
            events = winGame(events, .a)
            events = winGame(events, .b)
        }
        events += [.a, .a] // tiebreak 2-0
        let before = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(before.tiebreak, ScoreCount(a: 2, b: 0))

        let undone = ScorerEngine.computeState(initialServer: .a, events: Array(events.dropLast()))
        XCTAssertEqual(undone.tiebreak, ScoreCount(a: 1, b: 0))
    }

    func testUndoOutOfTiebreakWin() {
        var events: [Team] = []
        for _ in 0..<6 {
            events = winGame(events, .a)
            events = winGame(events, .b)
        }
        events += [.a, .a, .a, .a, .b, .b, .b, .b, .a, .a, .a] // tiebreak 7-4, A wins
        let before = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(before.sets.last?.winner, .a)

        let undone = ScorerEngine.computeState(initialServer: .a, events: Array(events.dropLast()))
        XCTAssertNotNil(undone.tiebreak, "still in the tiebreak")
        XCTAssertEqual(undone.tiebreak, ScoreCount(a: 6, b: 4))
        XCTAssertEqual(undone.sets.count, 0)
    }

    func testUndoOutOfDeuce() {
        let events: [Team] = [.a, .b, .a, .b, .a, .b] // reaches deuce on the last event
        let before = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(before.gamePhase, .deuce)

        let undone = ScorerEngine.computeState(initialServer: .a, events: Array(events.dropLast()))
        XCTAssertEqual(undone.gamePhase, .points)
        XCTAssertEqual(undone.points, ScoreCount(a: 3, b: 2))
    }

    func testUndoOutOfAdvantage() {
        let events: [Team] = [.a, .b, .a, .b, .a, .b, .a] // deuce then advantage A
        let before = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(before.gamePhase, .advantage)

        let undone = ScorerEngine.computeState(initialServer: .a, events: Array(events.dropLast()))
        XCTAssertEqual(undone.gamePhase, .deuce)
    }

    func testUndoOutOfGoldenPoint() {
        let events: [Team] = [.a, .b, .a, .b, .a, .b, .a, .b] // deuce, adv A, lost -> golden
        let before = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(before.gamePhase, .golden)

        let undone = ScorerEngine.computeState(initialServer: .a, events: Array(events.dropLast()))
        XCTAssertEqual(undone.gamePhase, .advantage)
        XCTAssertEqual(undone.advantageTeam, .a)
    }

    func testUndoGameWonFromGoldenPoint() {
        let events: [Team] = [.a, .b, .a, .b, .a, .b, .a, .b, .b] // ... golden point, B wins -> game B
        let before = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(before.games, ScoreCount(a: 0, b: 1))

        let undone = ScorerEngine.computeState(initialServer: .a, events: Array(events.dropLast()))
        XCTAssertEqual(undone.gamePhase, .golden)
        XCTAssertEqual(undone.games, ScoreCount())
    }

    func testUndoMatchWin() {
        var events: [Team] = []
        for _ in 0..<2 {
            for _ in 0..<6 { events = winGame(events, .a) }
        }
        let before = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(before.winner, .a)

        let undone = ScorerEngine.computeState(initialServer: .a, events: Array(events.dropLast()))
        XCTAssertNil(undone.winner)
        XCTAssertEqual(undone.setsWon, ScoreCount(a: 1, b: 0))
        XCTAssertEqual(undone.games, ScoreCount(a: 5, b: 0))
    }

    // MARK: - Service alternation

    func testServiceAlternation() {
        let s0 = ScorerEngine.computeState(initialServer: .a, events: [])
        XCTAssertEqual(s0.server, .a, "A serves first point")

        var events = winGame([], .a)
        let s1 = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(s1.server, .b, "B serves game 2")

        events = winGame(events, .b)
        let s2 = ScorerEngine.computeState(initialServer: .a, events: events)
        XCTAssertEqual(s2.server, .a, "A serves game 3")
    }

    // MARK: - MatchSnapshot round-trips through the state it wraps

    func testMatchSnapshotComputesTheSameState() {
        let events: [Team] = [.a, .a, .a, .a]
        let snapshot = MatchSnapshot(teamAName: "My Team", teamBName: "Opponent", initialServer: .a, events: events)
        XCTAssertEqual(snapshot.state, ScorerEngine.computeState(initialServer: .a, events: events))
    }
}
