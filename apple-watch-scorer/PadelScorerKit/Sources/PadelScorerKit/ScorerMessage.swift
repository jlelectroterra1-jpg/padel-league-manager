import Foundation

/// The WatchConnectivity message contract between WatchApp and PhoneApp -
/// defined once here so neither side hand-writes its own copy of these
/// string keys. Deliberately has no platform-specific imports (no
/// WatchConnectivity here) so it stays part of this plain, cross-platform
/// package; only WatchSessionManager/PhoneSessionManager (inside
/// WatchApp/PhoneApp, compiled as part of the real Xcode app targets)
/// import WatchConnectivity itself and use these constants.
public enum ScorerMessageKey {
    /// Sent watch -> phone each time a point is scored, for a future
    /// "live tap" animation on the phone. Value is a Team's rawValue
    /// ("A" or "B"). Not required for the phone to stay correct - the
    /// snapshot below is the source of truth - just a nicety.
    public static let pointScored = "POINT_SCORED"
    /// Sent watch -> phone to undo the last point. No payload.
    public static let undo = "UNDO"
    /// Sent watch -> phone to reset the match entirely. No payload.
    public static let reset = "RESET"
    /// The full current match, sent watch -> phone after every change, as
    /// a JSON-encoded MatchSnapshot. Delivered via WCSession's
    /// application context (not sendMessage) specifically so the phone
    /// catches up to the latest state next time it's reachable, even if
    /// it missed everything in between.
    public static let matchSnapshot = "MATCH_SNAPSHOT"
}

/// Everything the phone needs to mirror the watch's current match.
/// Deliberately carries the raw event list (not just a computed
/// MatchState) so the phone can independently call
/// ScorerEngine.computeState itself rather than trusting a snapshot it
/// has no way to verify - same event-sourced shape as the `match` object
/// scorer-lab-view.js persists to localStorage on the web
/// (teamAName/teamBName/initialServer/events).
public struct MatchSnapshot: Codable, Equatable, Sendable {
    public var teamAName: String
    public var teamBName: String
    public var initialServer: Team
    public var events: [Team]

    public init(teamAName: String, teamBName: String, initialServer: Team, events: [Team]) {
        self.teamAName = teamAName
        self.teamBName = teamBName
        self.initialServer = initialServer
        self.events = events
    }

    public var state: MatchState {
        ScorerEngine.computeState(initialServer: initialServer, events: events)
    }
}
