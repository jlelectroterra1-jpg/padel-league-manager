import Foundation
import PadelScorerKit

/// Owns the live match's event list (the only real state - see
/// PadelScorerKit.MatchState's doc comment) and republishes the computed
/// MatchState on every change - same event-sourced shape as the web
/// Scorer Lab's `match` object in scorer-lab-view.js (teamAName/
/// teamBName/initialServer/events). Also owns the WatchSessionManager so
/// every change gets pushed to the phone automatically; scoring itself
/// never waits on that send (matches the web's "must feel instant, no
/// network call in the tap path" requirement - WatchConnectivity sends
/// here are fire-and-forget, same idea applied to the watch).
@MainActor
final class ScorerViewModel: ObservableObject {
    @Published private(set) var teamAName: String = "My Team"
    @Published private(set) var teamBName: String = "Opponent"
    @Published private(set) var events: [Team] = []
    @Published private(set) var initialServer: Team = .a
    @Published private(set) var matchStarted: Bool = false

    private let sessionManager = WatchSessionManager()

    var state: MatchState {
        ScorerEngine.computeState(initialServer: initialServer, events: events)
    }

    func startMatch(teamAName: String, teamBName: String, initialServer: Team) {
        self.teamAName = teamAName.isEmpty ? "My Team" : teamAName
        self.teamBName = teamBName.isEmpty ? "Opponent" : teamBName
        self.initialServer = initialServer
        self.events = []
        self.matchStarted = true
        sendSnapshot()
    }

    func addPoint(_ team: Team) {
        guard matchStarted, state.winner == nil else { return }
        events.append(team)
        sessionManager.send(pointScoredBy: team)
        sendSnapshot()
    }

    func undoLastPoint() {
        guard !events.isEmpty else { return }
        events.removeLast()
        sessionManager.sendUndo()
        sendSnapshot()
    }

    func resetMatch() {
        events = []
        matchStarted = false
        sessionManager.sendReset()
    }

    func wouldWinMatch(_ team: Team) -> Bool {
        ScorerEngine.wouldWinMatch(events: events, initialServer: initialServer, team: team)
    }

    private func sendSnapshot() {
        let snapshot = MatchSnapshot(teamAName: teamAName, teamBName: teamBName, initialServer: initialServer, events: events)
        sessionManager.sendSnapshot(snapshot)
    }
}
