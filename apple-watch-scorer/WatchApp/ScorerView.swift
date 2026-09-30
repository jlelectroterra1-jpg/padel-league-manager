import SwiftUI
import PadelScorerKit

/// Main watch screen - two large tap zones filling almost the entire
/// display, same "green = my team, blue = opponent" concept as the web
/// Scorer Lab's .scorer-side buttons (see padel-league-manager/
/// scorer-lab-view.js and its landscape full-screen mode, which this is
/// visually closest to).
struct ScorerView: View {
    @ObservedObject var viewModel: ScorerViewModel

    var body: some View {
        if !viewModel.matchStarted {
            SetupView(viewModel: viewModel)
        } else {
            liveScoringView
        }
    }

    private var liveScoringView: some View {
        let state = viewModel.state
        let labels = ScorerEngine.pointLabel(state)

        return VStack(spacing: 2) {
            if let banner = specialStateLabel(state) {
                Text(banner)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(state.gamePhase == .golden ? .yellow : .secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .padding(.vertical, 2)
            }

            HStack(spacing: 2) {
                teamButton(team: .a, name: viewModel.teamAName, pointLabel: labels.a, games: state.games.a, serving: state.server == .a, color: .green)
                teamButton(team: .b, name: viewModel.teamBName, pointLabel: labels.b, games: state.games.b, serving: state.server == .b, color: .blue)
            }

            HStack {
                Button("Undo", action: viewModel.undoLastPoint)
                    .disabled(viewModel.events.isEmpty)
                Button("Reset", role: .destructive, action: viewModel.resetMatch)
            }
            .font(.system(size: 11))
        }
        .padding(4)
    }

    private func teamButton(team: Team, name: String, pointLabel: String, games: Int, serving: Bool, color: Color) -> some View {
        Button(action: { viewModel.addPoint(team) }) {
            VStack(spacing: 2) {
                Text(serving ? "🎾" : " ").font(.system(size: 10))
                Text(name).font(.system(size: 10, weight: .bold)).lineLimit(1).minimumScaleFactor(0.6)
                Text(pointLabel).font(.system(size: 34, weight: .heavy))
                Text("G:\(games)").font(.system(size: 10)).foregroundColor(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(color.opacity(0.25))
            .cornerRadius(8)
        }
        .buttonStyle(.plain)
        // touch-action:manipulation's watchOS equivalent isn't needed here -
        // watchOS doesn't have a double-tap-zoom gesture the way mobile
        // Safari does - but .plain keeps this from getting any default
        // button chrome/highlight fighting the big colored tap zone.
        .disabled(viewModel.state.winner != nil)
    }

    // Same priority order as the web's specialStateLabel(): match point
    // first (most urgent), then tiebreak, then the deuce/advantage/golden
    // point phase. Match complete has its own screen instead (see
    // liveScoringView's caller / a future MatchCompleteView), so this
    // returns nil once the match is decided.
    private func specialStateLabel(_ state: MatchState) -> String? {
        if state.winner != nil { return nil }
        let matchPointA = viewModel.wouldWinMatch(.a)
        let matchPointB = viewModel.wouldWinMatch(.b)
        if matchPointA || matchPointB {
            return "MATCH POINT - \(matchPointA ? viewModel.teamAName : viewModel.teamBName)"
        }
        if state.tiebreak != nil { return "TIEBREAK" }
        let phase = ScorerEngine.gamePhaseLabel(state)
        if phase.isEmpty { return nil }
        if phase == "Advantage" {
            return "ADVANTAGE - \(state.advantageTeam == .a ? viewModel.teamAName : viewModel.teamBName)"
        }
        return phase.uppercased()
    }
}

/// Minimal setup screen - team names default per the brief, plus who
/// serves first.
private struct SetupView: View {
    @ObservedObject var viewModel: ScorerViewModel
    @State private var nameA = "My Team"
    @State private var nameB = "Opponent"
    @State private var server: Team = .a

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                TextField("Team A", text: $nameA)
                TextField("Team B", text: $nameB)
                Picker("Serves first", selection: $server) {
                    Text(nameA.isEmpty ? "Team A" : nameA).tag(Team.a)
                    Text(nameB.isEmpty ? "Team B" : nameB).tag(Team.b)
                }
                Button("Start match") {
                    viewModel.startMatch(teamAName: nameA, teamBName: nameB, initialServer: server)
                }
            }
            .padding()
        }
    }
}
