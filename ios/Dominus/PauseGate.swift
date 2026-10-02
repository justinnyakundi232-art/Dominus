import SwiftUI

// The pause before a defence comes down.
//
// It says what is about to be given up, in the extension's words, and holds
// the button for Tasks.js's REMOVE_COOLDOWN_SECONDS. That is deliberately
// short. Dominus can be deleted in ten seconds by anyone who wants out, so
// none of this is a lock — it is a pause, aimed at the impulse rather than the
// decision. Someone who means to take a block down should be able to; they
// just shouldn't be able to do it without noticing they did.
//
// When a seal is set, this is where the password will be asked for instead.
struct PauseGate: View {
    let lines: [String]
    let seconds: Int
    let streak: Int
    let confirm: () -> Void
    let keep: () -> Void

    @State private var ends = Date()
    @State private var now = Date()

    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var remaining: Int {
        max(0, Int(ends.timeIntervalSince(now).rounded(.up)))
    }

    var body: some View {
        Page("Taking defences down") {
            // The line the extension's gates have carried since 1.4.5.
            if streak > 0 {
                Text("You're on a \(streak)-day discipline streak — don't dismantle what you've built.")
                    .foregroundStyle(Theme.gold)
            }

            Panel("This takes defences down") {
                ForEach(lines, id: \.self) { line in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text("—")
                            .foregroundStyle(Theme.goldDim)
                        Text(line)
                            .foregroundStyle(Theme.parchment)
                    }
                }
            }

            GoldButton("Keep my defences", action: keep)

            Button(action: confirm) {
                Text(remaining > 0 ? "WAIT \(remaining)" : "TAKE IT DOWN")
                    .font(.subheadline.weight(.semibold))
                    .tracking(1.5)
                    .monospacedDigit()
                    .foregroundStyle(remaining > 0 ? Theme.goldDim : Theme.gold)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity)
                    .overlay(Rectangle().stroke(remaining > 0 ? Theme.goldDim : Theme.gold, lineWidth: 1))
            }
            .disabled(remaining > 0)

            Text("Strengthening the fortress is always free. Weakening it waits.")
                .font(.footnote)
                .foregroundStyle(Theme.goldDim)
        }
        .onAppear {
            now = Date()
            ends = now.addingTimeInterval(TimeInterval(seconds))
        }
        .onReceive(tick) { now = $0 }
    }
}
