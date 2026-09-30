import SwiftUI
import PadelScorerKit

/// Read-only mirror of the watch's current match - current point, games,
/// sets won, and a set-by-set history. Deliberately basic for this phase
/// (per the brief: "do not overbuild the phone side yet") - phone-side
/// Undo and richer match overview are a later step once this scaffold is
/// actually running on a Mac.
struct MatchOverviewView: View {
    @ObservedObject var sessionManager: PhoneSessionManager

    var body: some View {
        NavigationView {
            Group {
                if let snapshot = sessionManager.snapshot {
                    matchView(snapshot)
                } else {
                    Text("Waiting for a match from your Apple Watch…")
                        .foregroundColor(.secondary)
                        .padding()
                }
            }
            .navigationTitle("Padel Scorer")
        }
    }

    private func matchView(_ snapshot: MatchSnapshot) -> some View {
        let state = snapshot.state
        let labels = ScorerEngine.pointLabel(state)

        return List {
            Section("Current point") {
                HStack {
                    VStack(alignment: .leading) {
                        Text(snapshot.teamAName).bold()
                        Text(labels.a).font(.system(size: 32, weight: .heavy))
                    }
                    Spacer()
                    VStack(alignment: .trailing) {
                        Text(snapshot.teamBName).bold()
                        Text(labels.b).font(.system(size: 32, weight: .heavy))
                    }
                }
            }

            Section("Games (current set)") {
                Text("\(state.games.a) - \(state.games.b)")
            }

            Section("Sets won") {
                Text("\(snapshot.teamAName) \(state.setsWon.a) - \(state.setsWon.b) \(snapshot.teamBName)")
            }

            Section("Score history") {
                ForEach(Array(state.sets.enumerated()), id: \.offset) { index, set in
                    Text("Set \(index + 1): \(set.games.a)-\(set.games.b)")
                }
                if state.winner == nil {
                    Text("Set \(state.sets.count + 1) (current): \(state.games.a)-\(state.games.b)")
                        .foregroundColor(.secondary)
                }
            }

            if let winner = state.winner {
                Section {
                    Text("🏆 \(winner == .a ? snapshot.teamAName : snapshot.teamBName) won the match")
                        .bold()
                }
            }
        }
    }
}
