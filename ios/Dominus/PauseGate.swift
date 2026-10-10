import SwiftUI

// The gate before a defence comes down.
//
// It says what is about to be given up, in the extension's words, and then
// asks for whatever this fortress charges.
//
// Unsealed, that is a wait: the button is held for Tasks.js's
// REMOVE_COOLDOWN_SECONDS. That is deliberately short. Dominus can be deleted
// in ten seconds by anyone who wants out, so none of this is a lock — it is a
// pause, aimed at the impulse rather than the decision. Someone who means to
// take a block down should be able to; they just shouldn't be able to do it
// without noticing they did.
//
// Sealed, it is the seal, and only the seal: as in Chrome, a password is the
// same idea with more weight behind it, so it replaces the wait rather than
// being added to it. It is always typed. A glance at the phone is no friction
// at all, and friction is the whole of what the seal is.
//
// A change of unlock task comes here too, because it could be a weakening: a
// Guarded Code swapped for a one-word message. But the extension's own line
// for it says "changed", not "weakened", and neither does this. `changeOnly`
// keeps the cost and drops the claim that defences are coming down.
struct PauseGate: View {
    let lines: [String]
    let changeOnly: Bool
    let seconds: Int
    let streak: Int
    @ObservedObject var seal: Seal
    let confirm: () -> Void
    let keep: () -> Void

    @State private var ends = Date()
    @State private var now = Date()
    @State private var password = ""
    @State private var refusal: String?

    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var remaining: Int {
        max(0, Int(ends.timeIntervalSince(now).rounded(.up)))
    }

    private var go: String {
        changeOnly ? "MAKE THE CHANGE" : "TAKE IT DOWN"
    }

    var body: some View {
        Page(changeOnly ? "Changing your defences" : "Taking defences down") {
            // The line the extension's gates have carried since 1.4.5. Left
            // out for a change, which dismantles nothing.
            if streak > 0 && !changeOnly {
                Text("You're on a \(streak)-day discipline streak — don't dismantle what you've built.")
                    .foregroundStyle(Theme.gold)
            }

            Panel(changeOnly ? "This changes what an unlock costs" : "This takes defences down") {
                ForEach(lines, id: \.self) { line in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text("—")
                            .foregroundStyle(Theme.goldDim)
                        Text(line)
                            .foregroundStyle(Theme.parchment)
                    }
                }
            }

            GoldButton(changeOnly ? "Keep it as it is" : "Keep my defences", action: keep)

            if seal.isSealed {
                sealed
            } else {
                waiting
            }
        }
        .onAppear {
            now = Date()
            ends = now.addingTimeInterval(TimeInterval(seconds))
        }
        .onReceive(tick) { now = $0 }
    }

    // MARK: - Unsealed: the wait

    @ViewBuilder
    private var waiting: some View {
        Button(action: confirm) {
            Text(remaining > 0 ? "WAIT \(remaining)" : go)
                .font(.subheadline.weight(.semibold))
                .tracking(1.5)
                .monospacedDigit()
                .foregroundStyle(remaining > 0 ? Theme.goldDim : Theme.gold)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity)
                .overlay(Rectangle().stroke(remaining > 0 ? Theme.goldDim : Theme.gold, lineWidth: 1))
        }
        .disabled(remaining > 0)

        Text(changeOnly
             ? "A change of task waits, because the new one may be easier than the old."
             : "Strengthening the fortress is always free. Weakening it waits.")
            .font(.footnote)
            .foregroundStyle(Theme.goldDim)
    }

    // MARK: - Sealed: the seal

    @ViewBuilder
    private var sealed: some View {
        Panel("The seal") {
            SealField("Your seal", text: $password)
            if let hint = seal.status?.hint, !hint.isEmpty {
                Text("Hint: \(hint)")
                    .font(.footnote)
                    .foregroundStyle(Theme.goldDim)
            }
            // Seal.js's own words, with the wait a third wrong try earns.
            if let refusal {
                Text(refusal)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }

        Button(action: tryTheSeal) {
            Text(go)
                .font(.subheadline.weight(.semibold))
                .tracking(1.5)
                .foregroundStyle(password.isEmpty ? Theme.goldDim : Theme.gold)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity)
                .overlay(Rectangle().stroke(password.isEmpty ? Theme.goldDim : Theme.gold, lineWidth: 1))
        }
        .disabled(password.isEmpty)

        Text(changeOnly
             ? "A change of task asks for the seal, because the new one may be easier than the old."
             : "Strengthening the fortress is always free. Weakening it costs the seal.")
            .font(.footnote)
            .foregroundStyle(Theme.goldDim)
    }

    private func tryTheSeal() {
        let outcome = seal.check(password)
        password = ""
        if outcome.ok {
            confirm()
        } else {
            refusal = outcome.error ?? "That isn't your seal."
        }
    }
}

// Where a seal is typed. Hidden as it is typed, and offered to a password
// manager: the extension lets a seal be pasted for the same reason — the
// target is not on screen, and a manager filling it in is someone using their
// own seal, not shortcutting a challenge.
struct SealField: View {
    private let title: String
    @Binding private var text: String

    init(_ title: String, text: Binding<String>) {
        self.title = title
        _text = text
    }

    var body: some View {
        SecureField("", text: $text, prompt: Text(title).foregroundColor(Theme.goldDim))
            .textContentType(.password)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .foregroundStyle(Theme.parchment)
            .padding(12)
            .background(Theme.panel)
            .overlay(Rectangle().stroke(Theme.goldDim.opacity(0.4), lineWidth: 1))
    }
}
