import Foundation
import WatchConnectivity
import PadelScorerKit

/// Thin WatchConnectivity wrapper for the watch side. Sends every point/
/// undo/reset to the paired phone (best-effort, never blocks scoring on
/// delivery - see ScorerViewModel, which updates local state immediately
/// and fires these sends afterward) and keeps a rolling application
/// context so a phone that wasn't reachable in the moment still catches
/// up to the latest state next time it's active. No internet involved at
/// all - WatchConnectivity works purely over Bluetooth/local Wi-Fi
/// between a paired watch and phone.
final class WatchSessionManager: NSObject {
    private let session: WCSession? = WCSession.isSupported() ? .default : nil

    override init() {
        super.init()
        session?.delegate = self
        session?.activate()
    }

    func send(pointScoredBy team: Team) {
        sendMessage([ScorerMessageKey.pointScored: team.rawValue])
    }

    func sendUndo() {
        sendMessage([ScorerMessageKey.undo: true])
    }

    func sendReset() {
        sendMessage([ScorerMessageKey.reset: true])
    }

    func sendSnapshot(_ snapshot: MatchSnapshot) {
        guard let session, session.activationState == .activated else { return }
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        // updateApplicationContext, not sendMessage, for the full
        // snapshot - it's designed exactly for "make sure the other side
        // eventually has the latest state", coalescing if several updates
        // land before the phone wakes up to process them, unlike
        // sendMessage which needs the counterpart reachable right now.
        try? session.updateApplicationContext([ScorerMessageKey.matchSnapshot: data])
    }

    private func sendMessage(_ message: [String: Any]) {
        guard let session, session.isReachable else { return }
        session.sendMessage(message, replyHandler: nil, errorHandler: nil)
    }
}

extension WatchSessionManager: WCSessionDelegate {
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
}
