import SwiftUI

@main
struct DominusApp: App {
    init() {
        // The tab bar takes the page's black rather than the system's
        // translucent grey, which reads as a different product.
        let bar = UITabBarAppearance()
        bar.configureWithOpaqueBackground()
        bar.backgroundColor = .black
        UITabBar.appearance().standardAppearance = bar
        UITabBar.appearance().scrollEdgeAppearance = bar
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .preferredColorScheme(.dark)
        }
    }
}

// The four sections, the same as in the extension and the desktop app, so
// moving between them is moving between windows rather than between products.
// The Order joins them when it exists.
struct RootView: View {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var fortress = Fortress()
    @StateObject private var record = Record()
    @StateObject private var seal = Seal()
    @StateObject private var session = Session()

    // Shown once, to a phone that has never had a fortress. Read before the
    // fortress is made for the first time, which is what "never had one"
    // means: an install from before the welcome existed has one already and
    // is not walked through it. See WelcomeView.
    @State private var welcoming = !UserDefaults.standard.bool(forKey: WelcomeView.seenKey)
        && FortressState.load() == nil

    private let tick = Timer.publish(every: 5, on: .main, in: .common).autoconnect()

    var body: some View {
        Group {
            if welcoming {
                WelcomeView {
                    UserDefaults.standard.set(true, forKey: WelcomeView.seenKey)
                    session.tab = .fortress
                    welcoming = false
                    refresh()
                }
            } else {
                tabs
            }
        }
        .environmentObject(fortress)
        .environmentObject(record)
        .environmentObject(seal)
        .environmentObject(session)
        .fullScreenCover(item: $session.unlocking) { unlocking in
            UnlockFlow(target: unlocking.target, fortress: fortress, record: record) {
                session.finish(unlocking)
                refresh()
            }
        }
        .onAppear(perform: refresh)
        .onChange(of: scenePhase) { phase in
            if phase == .active {
                refresh()
            }
        }
        // An unlock that runs out while the app is open ends in front of you.
        .onReceive(tick) { _ in
            fortress.refreshIfAnyEnded()
            seal.refreshIfRecovering()
        }
    }

    private var tabs: some View {
        TabView(selection: $session.tab) {
            KeepView()
                .tabItem { Label("Keep", systemImage: "shield.lefthalf.filled") }
                .tag(Session.Tab.keep)
            FortressView()
                .tabItem { Label("Fortress", systemImage: "building.columns") }
                .tag(Session.Tab.fortress)
            CampaignView()
                .tabItem { Label("Campaign", systemImage: "chart.bar") }
            .tag(Session.Tab.campaign)
            SealView()
                .tabItem { Label("Seal", systemImage: "lock.shield") }
            .tag(Session.Tab.seal)
        }
        .tint(Theme.gold)
    }

    // Everything that can have changed while the app was away: the fortress
    // (DominusMonitor may have put a block back), the record (stands made at
    // the block screen), and whether the block screen asked for an unlock.
    private func refresh() {
        fortress.refresh()
        record.refresh()
        seal.refresh()
        session.refresh()
        // A request to take the fortress down that is now ready is what its
        // notification was about, so it is put in front.
        if case .ready = fortress.standDown {
            session.tab = .keep
        }
    }
}
