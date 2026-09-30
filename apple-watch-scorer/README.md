# Padel Scorer — Apple Watch / iPhone prototype

Companion project for the web app's **Scorer Lab** (`padel-league-manager/owner.html`
→ Scorer Lab tab). This folder is **source code only** — prepared entirely on
Windows, with no Xcode and no Mac involved yet. It does not build, run, or
connect to anything by itself; see "What still needs Xcode/macOS" below for
exactly what's left.

**Nothing here touches the live web app, Supabase, real leagues, or organiser
accounts.** The web Scorer Lab (`scorer-engine.js`, `scorer-lab-view.js`) is
completely untouched and keeps working exactly as it does today, regardless
of what happens to this folder.

## Structure

```
apple-watch-scorer/
├── README.md                  ← this file
├── PadelScorerKit/             ← Swift Package: the shared scoring engine
│   ├── Package.swift
│   ├── Sources/PadelScorerKit/
│   │   ├── ScorerTypes.swift        (Team, GamePhase, ScoreCount, SetResult, MatchState)
│   │   ├── ScorerEngine.swift       (the actual scoring rules)
│   │   └── ScorerMessage.swift      (WatchConnectivity message contract, MatchSnapshot)
│   └── Tests/PadelScorerKitTests/
│       └── ScorerEngineTests.swift  (XCTest port of scorer-engine.js's own test suite)
├── WatchApp/                   ← source files for the future watchOS app
│   ├── PadelScorerWatchApp.swift    (@main entry point)
│   ├── ScorerViewModel.swift        (owns match state, talks to PadelScorerKit)
│   ├── ScorerView.swift             (the green/blue tap-to-score screen)
│   └── WatchSessionManager.swift    (WatchConnectivity, watch side)
└── PhoneApp/                   ← source files for the future iPhone companion app
    ├── PadelScorerPhoneApp.swift    (@main entry point)
    ├── PhoneSessionManager.swift    (WatchConnectivity, phone side)
    └── MatchOverviewView.swift      (read-only match display)
```

## 1. The scoring engine is real, testable code — not just a plan

`PadelScorerKit` is a genuine [Swift Package](https://www.swift.org/documentation/package-manager/)
— plain text, no Xcode-generated project file, so there was nothing fragile
to hand-write from Windows. It is a byte-for-byte behavioral port of
`padel-league-manager/scorer-engine.js`:

- Same event-sourced design: the only real state is an ordered list of
  point-winner events (`[Team]`, where `Team` is `.a`/`.b`). `ScorerEngine.computeState`
  always replays that list from scratch, which is what makes **Undo**
  trivially correct at every transition — dropping the last event and
  recomputing, never hand-reversing a counter.
- Same rules: 0/15/30/40 → Deuce → **one** Advantage → (if lost) **Golden
  Point** → game; games into sets (6 games with a 2-game lead, or 7-5);
  6-6 starts a tiebreak (first to 7, win by 2); best of 3 sets.
- `ScorerEngineTests.swift` is a direct port of the same test cases used to
  verify `scorer-engine.js` during development: point progression, both
  worked deuce/golden-point examples from the brief, the "only one
  advantage" rule, sets at 6-0/6-4/7-5, tiebreak boundary cases (7-6 is
  correctly *not* a win, 8-6/9-7 are), best-of-3 completion, match-point
  detection, and Undo immediately after a game/set/tiebreak/golden-point/
  match-winning point.

If `scorer-engine.js` ever changes, port the same change into
`ScorerEngine.swift` by hand and update `ScorerEngineTests.swift` to match —
there's no code-sharing between JavaScript and Swift (a webview-based
watchOS app isn't practical), so keeping the two test suites in lockstep is
what actually guarantees the watch matches the web.

## 2. What still requires Xcode/macOS

Everything below needs a Mac — none of it can be done from Windows:

1. **Verify the engine first, before anything else.** Open a terminal in
   `apple-watch-scorer/PadelScorerKit/` and run:
   ```bash
   swift test
   ```
   This alone doesn't need a full Xcode project — just Xcode's command line
   tools. If every test passes, the Swift engine's behavior is confirmed to
   match the web engine's own verified behavior.

2. **Create the watchOS app target.** In Xcode: File → New → Project →
   watchOS → App. Give it a name (e.g. "Padel Scorer") and a bundle
   identifier. Delete the template's placeholder `ContentView.swift`/App
   file, then drag the four files from `WatchApp/` into the project
   (uncheck "copy items" if you'd rather keep editing them in place in this
   repo, or check it to copy them into the new Xcode project — either
   works).

3. **Create the iOS app target** the same way (File → New → Project → iOS →
   App), and add the three files from `PhoneApp/` to it. Xcode will offer to
   add it to the *same* project as the watch app, or you can use "Add Target"
   inside the watch app's project instead — either is fine, but they must be
   part of the **same Xcode project** for Xcode to treat them as a paired
   watch+phone app.

4. **Add `PadelScorerKit` as a local Swift Package dependency to *both*
   targets** (File → Add Package Dependencies → Add Local... → select the
   `PadelScorerKit` folder). This is what makes `import PadelScorerKit`
   resolve in `WatchApp/` and `PhoneApp/`'s source files.

5. **Enable WatchConnectivity.** No special capability toggle is needed for
   basic `WCSession` usage (unlike push notifications or App Groups) — it
   works as soon as both targets link the `WatchConnectivity` framework
   (Xcode does this automatically once you `import WatchConnectivity` in a
   file that's part of the target).

6. **Signing.** Both targets need a development team selected under Signing
   & Capabilities before you can run on a real device. A free Apple ID is
   enough for local device testing; running on an actual paired Watch+iPhone
   (rather than just Simulators) will need that Apple ID added in Xcode's
   Accounts settings.

7. **Test the watch/phone pairing.** WatchConnectivity works between paired
   iOS Simulator + watchOS Simulator instances too, but it's more reliable
   and closer to real usage on an actual paired iPhone + Apple Watch. Either
   way: install both apps, start a match on the watch, and confirm the
   phone's "Waiting for a match…" screen updates once a point is scored.

## 3. Once you have temporary Mac access — exact next steps

1. `cd apple-watch-scorer/PadelScorerKit && swift test` — confirm all tests
   pass before touching anything else.
2. Open Xcode, create the watchOS + iOS app targets as described above.
3. Add the `WatchApp/` and `PhoneApp/` files to their respective targets,
   and add `PadelScorerKit` as a local package dependency to both.
4. Build and run the watch app in the Simulator first (no phone needed to
   confirm the scoring UI itself works) — start a match, tap through a few
   points, confirm Deuce/Advantage/Golden Point/Tiebreak/Match Point all
   display correctly, same as the web version.
5. Run both apps together (Simulator or real devices) and confirm a point
   scored on the watch shows up on the phone's Match Overview screen.
6. Only once that's solid: decide how/when to eventually sync a match to
   Supabase and connect it to a real league fixture — deliberately **not**
   part of this phase.

## What this phase deliberately does NOT do

- No Supabase connection, no login, no `organisers`/`leagues` tables touched.
- No connection to any real league, fixture, or team.
- No payments.
- No attempt to hand-write an `.xcodeproj`/`.pbxproj` file — those are
  fragile, effectively binary-ish plist files Xcode is meant to generate;
  writing one by hand from Windows would be more likely to produce a
  project Xcode can't even open than to save time. The Swift Package for
  the engine is real and buildable today; the app targets are one Xcode
  wizard away.
