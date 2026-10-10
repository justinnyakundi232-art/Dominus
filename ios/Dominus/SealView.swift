import SwiftUI

// The Seal: setting one, changing it, breaking it, and the way out when it
// has been forgotten.
//
// Setting a seal is free — it strengthens. Changing or breaking one asks for
// the seal it replaces, or "change seal" would be the way around the prompt
// for anyone holding an unlocked phone. Forgetting it costs an hour, with no
// master code and no back door: one would be found.
struct SealView: View {
    @EnvironmentObject private var seal: Seal

    private enum Doing {
        case nothing, changing, removing, forgetting
    }

    @State private var doing: Doing = .nothing
    @State private var current = ""
    @State private var next = ""
    @State private var again = ""
    @State private var hint = ""
    @State private var problem: String?

    var body: some View {
        Page("The Seal", subtitle: "Strengthening the fortress is free. Weakening it costs the seal.", emblem: "Seal") {
            if let status = seal.status {
                if !status.enabled {
                    unsealed(status)
                } else if status.recovering {
                    recovering(status)
                } else {
                    sealed(status)
                }
            }
            if let failure = seal.failure {
                Text(failure)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            whatItIs
        }
    }

    // MARK: - No seal

    private func unsealed(_ status: Seal.Status) -> some View {
        Panel("No seal set") {
            Text("Anything that weakens your fortress goes through a ten-second gate. A seal puts your own password there instead.")
                .foregroundStyle(Theme.parchment)
            newSealFields(status)
            if let problem {
                Text(problem)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            GoldButton("Set the seal") {
                guard matches() else { return }
                finish(seal.set(next, hint: hint))
            }
            .disabled(next.isEmpty)
            .opacity(next.isEmpty ? 0.4 : 1)
        }
    }

    // MARK: - Sealed

    @ViewBuilder
    private func sealed(_ status: Seal.Status) -> some View {
        Panel("The seal is set") {
            Text("Taking a defence down asks for it first.")
                .foregroundStyle(Theme.parchment)
            if !status.hint.isEmpty {
                Text("Hint: \(status.hint)")
                    .font(.footnote)
                    .foregroundStyle(Theme.goldDim)
            }
            if doing == .nothing {
                GoldButton("Change the seal", secondary: true) { begin(.changing) }
                GoldButton("Remove the seal", secondary: true) { begin(.removing) }
                Button("I forgot my seal") { begin(.forgetting) }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.gold)
                    .frame(maxWidth: .infinity)
            }
        }

        switch doing {
        case .nothing:
            EmptyView()

        case .changing:
            Panel("Change the seal") {
                SealField("Your current seal", text: $current)
                newSealFields(status)
                refusal
                GoldButton("Change it") {
                    guard matches() else { return }
                    finish(seal.change(current: current, next: next, hint: hint))
                }
                .disabled(current.isEmpty || next.isEmpty)
                .opacity(current.isEmpty || next.isEmpty ? 0.4 : 1)
                GoldButton("Cancel", secondary: true) { begin(.nothing) }
            }

        case .removing:
            // Breaking the seal is itself a weakening, so it costs the seal.
            Panel("Remove the seal") {
                Text("Without it, weakening the fortress waits ten seconds and asks for nothing.")
                    .foregroundStyle(Theme.parchment)
                SealField("Your current seal", text: $current)
                refusal
                GoldButton("Keep the seal") { begin(.nothing) }
                GoldButton("Remove it", secondary: true) {
                    finish(seal.clear(current))
                }
                .disabled(current.isEmpty)
                .opacity(current.isEmpty ? 0.4 : 1)
            }

        case .forgetting:
            Panel("Forgotten your seal") {
                Text("Dominus can lift it, an hour after you ask. Nothing changes until then: everything stays blocked and sealed, and you can call it off at any point.")
                    .foregroundStyle(Theme.parchment)
                Text("There is no master code and no faster way. If there were, it would be the way around the seal.")
                    .font(.footnote)
                    .foregroundStyle(Theme.goldDim)
                GoldButton("Never mind") { begin(.nothing) }
                GoldButton("Start the hour", secondary: true) {
                    seal.requestRecovery()
                    begin(.nothing)
                }
            }
        }
    }

    // MARK: - Recovery running

    private func recovering(_ status: Seal.Status) -> some View {
        Panel("The seal is lifting", glowing: true) {
            RecoveryStatus()
        }
    }

    // MARK: - Pieces

    @ViewBuilder
    private func newSealFields(_ status: Seal.Status) -> some View {
        SealField("New seal, at least \(status.minLength) characters", text: $next)
        SealField("The same again", text: $again)
        TextField("", text: $hint, prompt: Text("A hint, if you want one").foregroundColor(Theme.goldDim))
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .foregroundStyle(Theme.parchment)
            .padding(12)
            .background(Theme.panel)
            .overlay(Rectangle().stroke(Theme.goldDim.opacity(0.4), lineWidth: 1))
        Text("The hint is shown wherever the seal is asked for, to anyone holding the phone.")
            .font(.footnote)
            .foregroundStyle(Theme.goldDim)
    }

    @ViewBuilder
    private var refusal: some View {
        if let problem {
            Text(problem)
                .font(.footnote)
                .foregroundStyle(.red)
        }
    }

    private var whatItIs: some View {
        Panel("What the seal is, and isn't") {
            Text("It is asked for when a defence would come down: a category switched off, a site or an app removed, the unlock task cleared, the cooldown shortened, the fortress taken down. Unlocking one thing for a while is not sealed; that has its own cost.")
                .font(.footnote)
                .foregroundStyle(Theme.parchment)
            Text("It is not a lock. Deleting Dominus lifts everything, and always will. The seal is for the impulse, and for someone else idly picking up your phone.")
                .font(.footnote)
                .foregroundStyle(Theme.goldDim)
        }
    }

    // The two new-seal fields are compared here, before Seal.js is asked
    // anything, since it is only ever handed one of them.
    private func matches() -> Bool {
        if next != again {
            problem = "Those two don't match."
            return false
        }
        return true
    }

    private func begin(_ doing: Doing) {
        self.doing = doing
        current = ""
        next = ""
        again = ""
        hint = ""
        problem = nil
    }

    // Seal.js's own words on a refusal; a clean slate on success.
    private func finish(_ outcome: Seal.Outcome) {
        if outcome.ok {
            begin(.nothing)
        } else {
            current = ""
            problem = outcome.error ?? "That didn't work."
        }
    }
}

// A running recovery, shown here and on The Keep.
struct RecoveryStatus: View {
    @EnvironmentObject private var seal: Seal

    var body: some View {
        Text("Your seal lifts in \(seal.status?.recoveryRemaining ?? "under an hour").")
            .font(.display(20, relativeTo: .title3, bold: false))
            .foregroundStyle(Theme.parchment)
        Text("Until then everything stays blocked and sealed. Afterwards the fortress is still standing, without a seal, and you can set a new one.")
            .font(.footnote)
            .foregroundStyle(Theme.goldDim)
        GoldButton("Call it off") { seal.cancelRecovery() }
        Text("Calling it off is free. If you have remembered your seal, this is the thing to do.")
            .font(.footnote)
            .foregroundStyle(Theme.goldDim)
    }
}
