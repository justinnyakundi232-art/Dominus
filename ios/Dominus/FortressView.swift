import SwiftUI
import FamilyControls
import UserNotifications

// The Fortress: what is held, and the permissions it stands on.
//
// Still the test builds' controls, moved here as they were. Step 2 of the v1
// plan rebuilds this tab — categories that can be edited, the three tasks, the
// cooldown — and puts a cost on taking any of it down. Until then, taking the
// fortress down or a site off it is free.
struct FortressView: View {
    @EnvironmentObject private var fortress: Fortress
    @EnvironmentObject private var session: Session
    @ObservedObject private var center = AuthorizationCenter.shared

    @State private var pickerShown = false
    @State private var typed = ""
    @State private var typedRejected: String?
    @State private var failure: String?

    private let rules = SharedRules.shared

    var body: some View {
        Page("The Fortress") {
            permission
            if center.authorizationStatus == .approved {
                notificationPermission
                standing
                picked
                byName
            }
            plumbing
        }
        .familyActivityPicker(isPresented: $pickerShown, selection: $fortress.selection)
    }

    // MARK: - What it stands on

    private var permission: some View {
        Panel("Screen Time") {
            switch center.authorizationStatus {
            case .approved:
                Text("Allowed.")
                    .foregroundStyle(Theme.parchment)
            case .denied:
                // Denied is not final: iOS asks again on the next request, and
                // it can also be turned on in Settings → Screen Time.
                Text("Not allowed. Dominus cannot block anything without it.")
                    .foregroundStyle(Theme.parchment)
                GoldButton("Ask again", action: ask)
            default:
                Text("Dominus blocks apps and sites through Screen Time, which needs your permission first.")
                    .foregroundStyle(Theme.parchment)
                GoldButton("Allow Screen Time", action: ask)
            }
            if let failure {
                Text(failure)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
    }

    // An extension cannot open its app, so the block screen's Unlock button
    // posts a notification instead — which shows nothing without this.
    private var notificationPermission: some View {
        Panel("Notifications") {
            switch session.notifications {
            case .authorized, .provisional, .ephemeral:
                Text("Allowed. Unlock on the block screen sends a notification that opens Dominus.")
                    .foregroundStyle(Theme.parchment)
            case .denied:
                Text("Turned off. Unlock on the block screen can't reach you. Turn them on in Settings → Notifications → Dominus.")
                    .foregroundStyle(Theme.parchment)
            default:
                Text("Unlock on the block screen reaches you through a notification, since the block screen can't open Dominus itself.")
                    .foregroundStyle(Theme.parchment)
                GoldButton("Allow notifications") { session.allowNotifications() }
            }
        }
    }

    // MARK: - What is held

    private var standing: some View {
        Panel("The walls") {
            if fortress.isStanding {
                Text("Standing. What's below is blocked, and changes take effect as you make them.")
                    .foregroundStyle(Theme.parchment)
                GoldButton("Take it down", secondary: true) { fortress.standDown() }
            } else if fortress.isEmpty {
                Text("Nothing to block yet. Choose apps below, or add sites by name.")
                    .foregroundStyle(Theme.parchment)
            } else {
                Text("Down. Nothing is blocked.")
                    .foregroundStyle(Theme.parchment)
                GoldButton("Raise it") { fortress.raise() }
            }
        }
    }

    // Picked apps, categories and sites come back as tokens: Dominus can show
    // them with Apple's Label but never read which app or site they are. They
    // are unlocked from the block screen.
    private var picked: some View {
        let selection = fortress.selection
        let empty = selection.applicationTokens.isEmpty
            && selection.categoryTokens.isEmpty
            && selection.webDomainTokens.isEmpty

        return Panel("Apps") {
            GoldButton(empty ? "Choose apps" : "Change what's chosen", secondary: !empty) {
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
        Panel("Sites") {
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
                        HStack(spacing: 16) {
                            Text(site)
                                .foregroundStyle(Theme.parchment)
                            Spacer()
                            // The filter's page for a site typed by name has
                            // no buttons, so this is the only way to unlock one.
                            if fortress.isStanding {
                                if fortress.isOpen(.site(site)) {
                                    Text("Open")
                                        .font(.footnote)
                                        .foregroundStyle(Theme.goldDim)
                                } else {
                                    Button("Unlock") {
                                        session.begin(.site(site), fromRequest: false)
                                    }
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(Theme.gold)
                                }
                            }
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
    private var plumbing: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(rules.isLoaded
                 ? "Shared rules: the extension's Categories.js, Tasks.js and Stats.js are running on this phone."
                 : "Shared rules failed: \(rules.failure ?? "unknown error")")
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
}
