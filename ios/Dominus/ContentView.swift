import SwiftUI
import FamilyControls

// Build 2: block what is chosen, and find out how a site typed by name is
// blocked compared with one picked in Apple's picker. Still a test bench
// rather than Dominus — one screen, no friction on taking anything down.

struct ContentView: View {
    @ObservedObject private var center = AuthorizationCenter.shared
    @StateObject private var fortress = Fortress()
    @State private var pickerShown = false
    @State private var typed = ""
    @State private var typedRejected: String?
    @State private var failure: String?

    private let rules = SharedRules.shared

    var body: some View {
        ZStack {
            Theme.ground.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    header
                    permission
                    if center.authorizationStatus == .approved {
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
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("DOMINUS")
                .font(.system(.largeTitle, design: .serif).weight(.bold))
                .tracking(4)
                .foregroundStyle(Theme.gold)
            Text("Build 2. Blocks what you choose.")
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

    // Whether the phone is really running the extension's JavaScript is one
    // of the things this build exists to find out, so it says so.
    private var footer: some View {
        Text(rules.isLoaded
             ? "Shared rules: the extension's Categories.js is running on this phone."
             : "Shared rules failed to load: \(rules.failure ?? "unknown error")")
            .font(.caption)
            .foregroundStyle(rules.isLoaded ? Theme.goldDim : .red)
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
