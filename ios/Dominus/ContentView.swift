import SwiftUI
import FamilyControls

// The first build does one thing on purpose: prove the path to the phone. If
// this screen arrives through TestFlight, asks for Screen Time and opens
// Apple's picker, then signing, the Family Controls entitlement and the upload
// all work, and everything after it is Dominus rather than plumbing.
//
// Nothing here blocks anything yet, and nothing is saved.

struct ContentView: View {
    @ObservedObject private var center = AuthorizationCenter.shared
    @State private var selection = FamilyActivitySelection()
    @State private var pickerShown = false
    @State private var failure: String?

    var body: some View {
        ZStack {
            Theme.ground.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    header
                    permission
                    if center.authorizationStatus == .approved {
                        picked
                    }
                }
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .familyActivityPicker(isPresented: $pickerShown, selection: $selection)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("DOMINUS")
                .font(.system(.largeTitle, design: .serif).weight(.bold))
                .tracking(4)
                .foregroundStyle(Theme.gold)
            Text("First build. Proves the path to the phone.")
                .font(.footnote)
                .foregroundStyle(Theme.goldDim)
        }
    }

    private var permission: some View {
        section("Screen Time") {
            switch center.authorizationStatus {
            case .approved:
                Text("Allowed. Dominus can see what you choose to block.")
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

    // What the picker hands back is tokens, not names: Dominus can draw them
    // with Apple's own Label but never read which app or site they are. That
    // is the first of the three things this build is meant to confirm.
    private var picked: some View {
        section("Chosen") {
            button(selection.isEmpty ? "Choose apps and sites" : "Change what's chosen") {
                pickerShown = true
            }
            if selection.isEmpty {
                Text("Nothing chosen yet.")
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

    private func button(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title.uppercased())
                .font(.subheadline.weight(.semibold))
                .tracking(1.5)
                .foregroundStyle(Theme.ground)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity)
                .background(Theme.gold)
        }
    }
}

private extension FamilyActivitySelection {
    var isEmpty: Bool {
        applicationTokens.isEmpty && categoryTokens.isEmpty && webDomainTokens.isEmpty
    }
}
