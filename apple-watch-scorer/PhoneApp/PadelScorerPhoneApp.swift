import SwiftUI

/// Entry point for the iPhone companion app. Deliberately minimal for
/// now, per the brief ("do not overbuild the phone side yet") - just
/// enough structure to receive and display what the watch sends. See
/// apple-watch-scorer/README.md for the Xcode steps still needed.
@main
struct PadelScorerPhoneApp: App {
    @StateObject private var sessionManager = PhoneSessionManager()

    var body: some Scene {
        WindowGroup {
            MatchOverviewView(sessionManager: sessionManager)
        }
    }
}
