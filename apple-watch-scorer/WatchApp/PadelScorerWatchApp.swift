import SwiftUI

/// Entry point for the watchOS app. NOTE: this file alone doesn't make a
/// runnable app - see apple-watch-scorer/README.md for the Xcode steps
/// still needed (creating an actual watchOS App target and adding the
/// files in this folder to it, plus adding PadelScorerKit as a local
/// Swift Package dependency).
@main
struct PadelScorerWatchApp: App {
    @StateObject private var viewModel = ScorerViewModel()

    var body: some Scene {
        WindowGroup {
            ScorerView(viewModel: viewModel)
        }
    }
}
