import SwiftUI
import FamilyControls
import UserNotifications

// Build 3: the block screen is Dominus's own, and its Unlock button finds a
// way back here. Still a test bench rather than Dominus — one screen, and an
// unlock request is only shown, not yet acted on.

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject private var center = AuthorizationCenter.shared
    @StateObject private var fortress = Fortress()
    @State private var pickerShown = false
    @State private var typed = ""
    @State private var typedRejected: String?
    @State private var failure: String?

    // Written by the block screen's extension, read here. Refreshed whenever
    // the app comes to the front, since that is how a request arrives.
    @State private var pending: Gate.UnlockRequest?
    @State private var stands = 0
    @State private var notifications: UNAuthorizationStatus = .notDetermined

    private let rules = SharedRules.shared

    var body: some View {
        ZStack {
            Theme.ground.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    header
                    if let pending {
                        unlockRequested(pending)
                    }
                    permission
                    if center.authorizationStatus == .approved {
                        notificationPermission
                        standing
                        picked
                        byName
                    }
                    footer
                }
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .familyActivityPicker(isPresented: $pickerShown, selection: $fortress.selection)
        .onAppear(perform: refresh)
        .onChange(of: scenePhase) { phase in
            if phase == .active {
                refresh()
            }
        }
    }

    // What the Unlock button on the block screen leads to. The cooldown, the
    // task and the fifteen minutes are the next build; this one proves the
    // way here.
    private func unlockRequested(_ request: Gate.UnlockRequest) -> some View {
        section("Unlock requested") {
            label(for: request.target)
                .foregroundStyle(Theme.parchment)
            (Text("Asked ") + Text(request.at, style: .relative) + Text(" ago from the block screen."))
                .font(.footnote)
                .foregroundStyle(Theme.goldDim)
            Text("Next build: the cooldown and the task run here, and then it opens for fifteen minutes. For now this only proves the block screen can send you here.")
                .foregroundStyle(Theme.parchment)
            button("Dismiss", secondary: true) {
                Gate.clearUnlock()
                pending = nil
            }
        }
    }

    @ViewBuilder
    private func label(for target: Gate.UnlockRequest.Target) -> some View {
        switch target {
        case .application(let token): Label(token)
        case .webDomain(let token): Label(token)
        case .category(let token): Label(token)
        }
    }

    // An extension cannot open its app, so the block screen's Unlock button
    // posts a notification instead — which shows nothing without this.
    private var notificationPermission: some View {
        section("Notifications") {
            switch notifications {
            case .authorized, .provisional, .ephemeral:
                Text("Allowed. Unlock on the block screen will send a notification that opens Dominus.")
                    .foregroundStyle(Theme.parchment)
            case .denied:
                Text("Turned off. Unlock on the block screen can't reach you. Turn them on in Settings → Notifications → Dominus.")
                    .foregroundStyle(Theme.parchment)
            default:
                Text("Unlock on the block screen reaches you through a notification, since the block screen can't open Dominus itself.")
                    .foregroundStyle(Theme.parchment)
                button("Allow notifications", action: allowNotifications)
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("DOMINUS")
                .font(.system(.largeTitle, design: .serif).weight(.bold))
                .tracking(4)
                .foregroundStyle(Theme.gold)
            Text("Build 3. The block screen is Dominus's.")
                .font(.footnote)
                .foregroundStyle(Theme.goldDim)
        }
    }

    private var permission: some View {
        section("Screen Time") {
            switch center.authorizationStatus {
            case .approved:
                Text("Allowed.")
                    .foregroundStyle(Theme.parchment)
            case .denied:
                // Denied is not final: iOS asks again on the next request, and
                // it can also be turned on in Settings → Screen Time.
                Text("Not allowed. Dominus cannot block anything without it.")
                    .foregroundStyle(Theme.parchment)
                button("Ask again", action: ask)
            default:
                Text("Dominus blocks apps and sites through Screen Time, which needs your permission first.")
                    .foregroundStyle(Theme.parchment)
                button("Allow Screen Time", action: ask)
            }
            if let failure {
                Text(failure)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
    }

    private var standing: some View {
        section("The fortress") {
            if fortress.isStanding {
                Text("Standing. What's below is blocked, and changes take effect as you make them.")
                    .foregroundStyle(Theme.parchment)
                button("Take it down", secondary: true) { fortress.standDown() }
            } else if fortress.isEmpty {
                Text("Nothing to block yet. Choose apps below, or add sites by name.")
                    .foregroundStyle(Theme.parchment)
            } else {
                Text("Down. Nothing is blocked.")
                    .foregroundStyle(Theme.parchment)
                button("Raise it") { fortress.raise() }
            }
            Text(stands == 1 ? "1 stand at the block screen." : "\(stands) stands at the block screen.")
                .font(.footnote)
                .foregroundStyle(Theme.goldDim)
        }
    }

    // Picked apps, categories and sites come back as tokens: Dominus can show
    // them with Apple's Label but never read which app or site they are.
    private var picked: some View {
        let selection = fortress.selection
        let empty = selection.applicationTokens.isEmpty
            && selection.categoryTokens.isEmpty
            && selection.webDomainTokens.isEmpty

        return section("Chosen in the picker") {
            button(empty ? "Choose apps and sites" : "Change what's chosen", secondary: !empty) {
                pickerShown = true
            }
            if empty {
                Text("Nothing chosen.")
                    .foregroundStyle(Theme.parchment)
            } else {
                Text("\(selection.applicationTokens.count) apps · \(selection.categoryTokens.count) categories · \(selection.webDomainTokens.count) sites")
                    .font(.footnote)
                    .foregroundStyle(Theme.goldDim)
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(selection.applicationTokens), id: \.self) { Label($0) }
                    ForEach(Array(selection.categoryTokens), id: \.self) { Label($0) }
                    ForEach(Array(selection.webDomainTokens), id: \.self) { Label($0) }
                }
                .foregroundStyle(Theme.parchment)
            }
        }
    }

    // Sites by name, cleaned by the extension's own normalizeDomain(), so a
    // pasted "https://www.youtube.com/feed" is stored as "youtube.com" here
    // exactly as it would be in Chrome.
    private var byName: some View {
        section("Sites by name") {
            HStack(spacing: 10) {
                TextField("", text: $typed, prompt: Text("youtube.com").foregroundColor(Theme.goldDim))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.done)
                    .onSubmit(addTyped)
                    .foregroundStyle(Theme.parchment)
                    .padding(12)
                    .background(Theme.panel)
                    .overlay(Rectangle().stroke(Theme.goldDim.opacity(0.4), lineWidth: 1))
                Button("Add", action: addTyped)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.gold)
            }
            if let typedRejected {
                Text("\u{201C}\(typedRejected)\u{201D} isn't a site Dominus can block.")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }

            if !rules.defaultCategories.isEmpty {
                Menu {
                    ForEach(rules.defaultCategories) { category in
                        Button("\(category.name) (\(category.sites.count) sites)") {
                            fortress.addSites(category.sites)
                        }
                    }
                } label: {
                    Text("ADD A CATEGORY FROM THE EXTENSION")
                        .font(.caption.weight(.semibold))
                        .tracking(1.2)
                        .foregroundStyle(Theme.gold)
                }
            }

            if fortress.sites.isEmpty {
                Text("None added.")
                    .foregroundStyle(Theme.parchment)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(fortress.sites, id: \.self) { site in
                        HStack {
                            Text(site)
                                .foregroundStyle(Theme.parchment)
                            Spacer()
                            Button {
                                fortress.removeSite(site)
                            } label: {
                                Image(systemName: "xmark")
                                    .foregroundStyle(Theme.goldDim)
                            }
                            .accessibilityLabel("Remove \(site)")
                        }
                    }
                }
            }
        }
    }

    // The plumbing each build depends on, stated rather than assumed: the
    // extension's JavaScript, the storage shared with the block screen, and
    // whether the block screen's last notification got through.
    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(rules.isLoaded
                 ? "Shared rules: the extension's Categories.js is running on this phone."
                 : "Shared rules failed to load: \(rules.failure ?? "unknown error")")
                .foregroundStyle(rules.isLoaded ? Theme.goldDim : .red)
            Text(Gate.defaults != nil
                 ? "Shared storage: the block screen and the app can reach each other."
                 : "Shared storage is missing: the App Group isn't set up, so the block screen can't reach the app.")
                .foregroundStyle(Gate.defaults != nil ? Theme.goldDim : .red)
            if let notificationFailure = Gate.notificationFailure {
                Text("The block screen's last notification failed: \(notificationFailure)")
                    .foregroundStyle(.red)
            }
        }
        .font(.caption)
    }

    private func refresh() {
        pending = Gate.pendingUnlock
        stands = Gate.stands.count
        Task {
            notifications = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        }
    }

    private func allowNotifications() {
        Task {
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
            notifications = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        }
    }

    private func addTyped() {
        let raw = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return }
        if fortress.addSite(raw) != nil {
            typed = ""
            typedRejected = nil
        } else {
            typedRejected = raw
        }
    }

    private func ask() {
        Task {
            do {
                try await center.requestAuthorization(for: .individual)
                failure = nil
            } catch {
                failure = error.localizedDescription
            }
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title.uppercased())
                .font(.caption.monospaced())
                .tracking(2)
                .foregroundStyle(Theme.goldDim)
            content()
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.section)
        .overlay(Rectangle().stroke(Theme.goldDim.opacity(0.4), lineWidth: 1))
    }

    private func button(_ title: String, secondary: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title.uppercased())
                .font(.subheadline.weight(.semibold))
                .tracking(1.5)
                .foregroundStyle(secondary ? Theme.gold : Theme.ground)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity)
                .background(secondary ? Color.clear : Theme.gold)
                .overlay(Rectangle().stroke(Theme.gold, lineWidth: secondary ? 1 : 0))
        }
    }
}
