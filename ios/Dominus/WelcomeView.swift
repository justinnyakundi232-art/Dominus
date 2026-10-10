import SwiftUI
import FamilyControls
import UserNotifications

// The first run: what Dominus is, the two permissions it stands on, and the
// way in.
//
// Until now those permissions were panels in The Fortress, found by whoever
// went looking. Someone opening the app for the first time should be told
// what it does and asked for each thing once, with the reason beside the
// button — and then never shown this again.
//
// Nothing here is required to get past. Screen Time can be refused and
// notifications skipped; The Fortress still asks for whatever is missing.
struct WelcomeView: View {
    static let seenKey = "welcome.seen"

    let done: () -> Void

    @EnvironmentObject private var session: Session
    @ObservedObject private var center = AuthorizationCenter.shared

    private enum Step {
        case what, screenTime, notifications, begin
    }

    @State private var step: Step = .what
    @State private var failure: String?

    var body: some View {
        ZStack {
            Theme.ground.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 24) {
                    Emblem(name: "Golden crown and crossed swords emblem", height: 110)
                        .padding(.top, 32)

                    switch step {
                    case .what: what
                    case .screenTime: screenTime
                    case .notifications: notifications
                    case .begin: begin
                    }
                }
                .padding(24)
                .frame(maxWidth: .infinity)
            }
        }
    }

    // MARK: - The steps

    private var what: some View {
        VStack(spacing: 18) {
            title("DOMINUS")
            Text("Stay focused. Build discipline.")
                .font(.display(20, relativeTo: .title3, bold: false))
                .foregroundStyle(Theme.parchment)
            words("Dominus blocks the apps and sites you choose, and makes unblocking them cost something: a task, a wait, and a password if you set one.")
            words("It is a tool, not a cage. You set every rule, everything stays on this phone, and deleting the app lifts every block.")
            GoldButton("Begin") { step = .screenTime }
        }
    }

    private var screenTime: some View {
        VStack(spacing: 18) {
            title("Screen Time")
            words("Dominus blocks through Apple's Screen Time, which needs your permission first.")
            words("It is only ever told which apps to hold. It cannot read what they are called, and it never sees what you do in them.")
            if center.authorizationStatus == .approved {
                note("Allowed.")
                GoldButton("Continue") { step = .notifications }
            } else {
                GoldButton(center.authorizationStatus == .denied ? "Ask again" : "Allow Screen Time", action: allowScreenTime)
                quiet("Not now") { step = .notifications }
            }
            if let failure {
                Text(failure)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private var notifications: some View {
        VStack(spacing: 18) {
            title("Notifications")
            words("A blocked app shows the Dominus block screen, with an Unlock button. That screen cannot open Dominus by itself, so it sends a notification that does.")
            words("The only other ones Dominus sends tell you that a wait you started is over.")
            if notificationsAllowed {
                note("Allowed.")
                GoldButton("Continue") { step = .begin }
            } else {
                GoldButton("Allow notifications") {
                    session.allowNotifications()
                }
                quiet("Skip") { step = .begin }
            }
        }
        // Asking is answered a moment later, and the answer moves this on.
        .onChange(of: session.notifications) { _ in
            if notificationsAllowed {
                step = .begin
            }
        }
    }

    private var begin: some View {
        VStack(spacing: 18) {
            title("Raise your fortress")
            words("Choose the apps to hold, switch on a category of sites, or block one by hand. Then raise the walls.")
            words("Adding to the fortress is always free. Taking from it waits.")
            GoldButton("To The Fortress", action: done)
        }
    }

    // MARK: - Pieces

    private var notificationsAllowed: Bool {
        switch session.notifications {
        case .authorized, .provisional, .ephemeral: return true
        default: return false
        }
    }

    private func title(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.display(30, relativeTo: .largeTitle))
            .tracking(2)
            .foregroundStyle(Theme.gold)
            .multilineTextAlignment(.center)
    }

    private func words(_ text: String) -> some View {
        Text(text)
            .foregroundStyle(Theme.parchment)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Theme.goldDim)
    }

    private func quiet(_ text: String, action: @escaping () -> Void) -> some View {
        Button(text, action: action)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Theme.goldDim)
    }

    private func allowScreenTime() {
        Task {
            do {
                try await center.requestAuthorization(for: .individual)
                failure = nil
                step = .notifications
            } catch {
                // Refused, or not possible on this phone. Either way it can
                // be asked again from The Fortress.
                failure = "Screen Time wasn't allowed. Dominus can't block anything without it; you can allow it later from The Fortress."
            }
        }
    }
}
