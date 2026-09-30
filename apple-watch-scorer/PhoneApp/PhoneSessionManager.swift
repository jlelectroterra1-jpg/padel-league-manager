import Foundation
import WatchConnectivity
import PadelScorerKit

/// Phone-side counterpart to WatchSessionManager - receives the watch's
/// application context (the latest MatchSnapshot) and republishes it for
/// MatchOverviewView. The phone never originates scoring actions in this
/// phase; it's a read-only mirror of whatever the watch has, per the
/// brief ("do not overbuild the phone side yet"). No internet involved -
/// WatchConnectivity is a direct watch<->phone link.
@MainActor
final class PhoneSessionManager: NSObject, ObservableObject {
    @Published private(set) var snapshot: MatchSnapshot?

    private let session: WCSession? = WCSession.isSupported() ? .default : nil

    override init() {
        super.init()
        session?.delegate = self
        session?.activate()
    }
}

extension PhoneSessionManager: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        guard let data = applicationContext[ScorerMessageKey.matchSnapshot] as? Data,
              let decoded = try? JSONDecoder().decode(MatchSnapshot.self, from: data) else { return }
        Task { @MainActor in
            self.snapshot = decoded
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        // Individual point/undo/reset messages arrive here in real time
        // when both devices are reachable; the application context above
        // is the source of truth for display, so these aren't required
        // for MatchOverviewView to work - available here for a future
        // "live tap" animation if wanted, without changing the contract.
    }
}
