import SwiftUI
import FamilyControls

// The unlock, as the extension's blocked page runs it: the task, then the
// cooldown, then a last word before anything opens.
//
//   - The task is Random Passage, the one that needs nothing set up first: a
//     fresh line from Tasks.js's generatePassage(), typed back exactly, with
//     pasting refused. Compared as the blocked page compares it — trimmed,
//     then exact.
//   - The cooldown is Tasks.js's effectiveCooldownSeconds(), escalating with
//     each unlock of the same thing today. Leaving Dominus starts it over:
//     the wait is the friction, and a wait spent elsewhere isn't one.
//   - Stay focused, at any point, is a stand.
struct UnlockFlow: View {
    let target: LockTarget
    @ObservedObject var fortress: Fortress
    @ObservedObject var record: Record
    let done: () -> Void

    @Environment(\.scenePhase) private var scenePhase

    private enum Step: Equatable {
        case task
        case cooldown(ends: Date)
        case confirm
    }

    @State private var step: Step = .task
    @State private var passage = SharedRules.shared.generatePassage()
    @State private var typed = ""
    @State private var now = Date()
    @State private var leftDuringCooldown = false
    @State private var startedOver = false
    @State private var failure: String?

    // Until the phone has settings: the extension's floor of 60 seconds, with
    // escalation on so it can be seen working. 60, 75, 94, 117… capped at an
    // hour by Tasks.js itself.
    private static let cooldownSettings: [String: Any] = ["seconds": 60, "escalate": true, "factor": 1.25]

    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var seconds: Int {
        SharedRules.shared.effectiveCooldownSeconds(
            Self.cooldownSettings,
            priorUnlocks: fortress.unlocksToday(of: target)
        )
    }

    var body: some View {
        ZStack {
            Theme.ground.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Text("UNLOCK")
                        .font(.system(.largeTitle, design: .serif).weight(.bold))
                        .tracking(4)
                        .foregroundStyle(Theme.gold)
                    TargetLabel(target: target)
                        .font(.title3)
                        .foregroundStyle(Theme.parchment)

                    switch step {
                    case .task: task
                    case .cooldown(let ends): cooldown(ends: ends)
                    case .confirm: confirm
                    }

                    if let failure {
                        Text(failure)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }

                    Button {
                        record.stand()
                        done()
                    } label: {
                        Text("STAY FOCUSED")
                            .font(.subheadline.weight(.semibold))
                            .tracking(1.5)
                            .foregroundStyle(Theme.ground)
                            .padding(.vertical, 14)
                            .frame(maxWidth: .infinity)
                            .background(Theme.gold)
                    }
                    Text("Walking away counts as a stand.")
                        .font(.footnote)
                        .foregroundStyle(Theme.goldDim)
                }
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .onReceive(tick) { date in
            now = date
            if case .cooldown(let ends) = step, date >= ends {
                step = .confirm
            }
        }
        .onChange(of: scenePhase) { phase in
            guard case .cooldown = step else { return }
            if phase == .background {
                leftDuringCooldown = true
            } else if phase == .active && leftDuringCooldown {
                leftDuringCooldown = false
                startedOver = true
                startCooldown()
            }
        }
    }

    private var task: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Type this passage exactly to begin your cooldown:")
                .foregroundStyle(Theme.parchment)
            Text(passage)
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(Theme.gold)
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.panel)
            NoPasteField(text: $typed)
                .background(Theme.panel)
                .overlay(Rectangle().stroke(Theme.goldDim.opacity(0.4), lineWidth: 1))
                .onChange(of: typed) { value in
                    if value.trimmingCharacters(in: .whitespacesAndNewlines)
                        == passage.trimmingCharacters(in: .whitespacesAndNewlines) {
                        startCooldown()
                    }
                }
            Text("Pasting is disabled.")
                .font(.footnote)
                .foregroundStyle(Theme.goldDim)
        }
    }

    // `now` only moves once a second, so at the moment a cooldown starts it
    // can be most of a second stale — which made a 60-second cooldown open on
    // 1:01. It is brought up to date here, and the display is capped at the
    // cooldown's own length as well.
    private func startCooldown() {
        now = Date()
        step = .cooldown(ends: now.addingTimeInterval(TimeInterval(seconds)))
    }

    private func cooldown(ends: Date) -> some View {
        let remaining = min(seconds, max(0, Int(ends.timeIntervalSince(now).rounded(.up))))
        let prior = fortress.unlocksToday(of: target)
        return VStack(alignment: .leading, spacing: 14) {
            Text(SharedRules.shared.formatClock(remaining))
                .font(.system(size: 64, weight: .bold, design: .serif))
                .monospacedDigit()
                .foregroundStyle(Theme.gold)
            Text(startedOver
                 ? "You left Dominus, so the cooldown started over. Stay here until it ends."
                 : "Stay here until it ends. Leaving Dominus starts it over.")
                .foregroundStyle(Theme.parchment)
            if prior > 0 {
                Text("Unlocked \(prior) \(prior == 1 ? "time" : "times") already today, so this wait is longer.")
                    .font(.footnote)
                    .foregroundStyle(Theme.goldDim)
            }
        }
    }

    private var confirm: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("This opens it for \(SharedRules.shared.formatHuman(Int(target.window))), then the block comes back on its own. It counts as a slip.")
                .foregroundStyle(Theme.parchment)
            Button {
                do {
                    try fortress.unlock(target)
                    record.slip(domain: target.domain)
                    done()
                } catch {
                    failure = error.localizedDescription
                }
            } label: {
                Text("UNLOCK")
                    .font(.subheadline.weight(.semibold))
                    .tracking(1.5)
                    .foregroundStyle(Theme.gold)
                    .padding(.vertical, 14)
                    .frame(maxWidth: .infinity)
                    .overlay(Rectangle().stroke(Theme.gold, lineWidth: 1))
            }
        }
    }
}

// A typing box that refuses pasting and dropping, as the blocked page's
// blockPasteOn() does. Without it the passage is on screen and copy-paste
// makes the task two taps. Autocorrect and prediction are off too, so the
// keyboard doesn't type the words for you.
//
// A text view rather than a text field: a passage is twelve words, and a
// single-line field grows sideways with what is typed, taking the page with it
// and pushing the passage out of sight. This one keeps the width it is given
// and wraps, growing downward instead.
struct NoPasteField: UIViewRepresentable {
    @Binding var text: String

    func makeUIView(context: Context) -> UITextView {
        let view = PasteRefusingTextView()
        view.delegate = context.coordinator
        view.textDropDelegate = context.coordinator
        view.backgroundColor = .clear
        view.textColor = UIColor(red: 0xE5 / 255, green: 0xE5 / 255, blue: 0xE5 / 255, alpha: 1)
        view.tintColor = UIColor(red: 0xD4 / 255, green: 0xAF / 255, blue: 0x37 / 255, alpha: 1)
        view.font = .monospacedSystemFont(ofSize: 17, weight: .regular)
        view.textContainerInset = UIEdgeInsets(top: 12, left: 8, bottom: 12, right: 8)
        // Not scrolling is what lets it report its own height and grow.
        view.isScrollEnabled = false
        view.autocapitalizationType = .none
        view.autocorrectionType = .no
        view.spellCheckingType = .no
        view.smartQuotesType = .no
        view.smartDashesType = .no
        view.smartInsertDeleteType = .no
        if #available(iOS 17.0, *) {
            view.inlinePredictionType = .no
        }
        view.returnKeyType = .done
        // Its natural width is that of its text on one line. Left to insist on
        // that, it would stretch the page exactly as the field did.
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text {
            view.text = text
        }
    }

    // The width SwiftUI offers, and whatever height the text needs at that
    // width — never less than three lines, so it reads as somewhere to type.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, width > 0 else { return nil }
        let fitted = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: max(96, fitted.height))
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text)
    }

    final class Coordinator: NSObject, UITextViewDelegate, UITextDropDelegate {
        private let text: Binding<String>

        init(text: Binding<String>) {
            self.text = text
        }

        func textViewDidChange(_ view: UITextView) {
            text.wrappedValue = view.text ?? ""
        }

        // A passage is one line of words, so Return puts the keyboard away
        // rather than adding a line break that could never match.
        func textView(_ view: UITextView, shouldChangeTextIn range: NSRange, replacementText replacement: String) -> Bool {
            if replacement == "\n" {
                view.resignFirstResponder()
                return false
            }
            return true
        }

        func textDroppableView(_ textDroppableView: UIView & UITextDroppable, proposalForDrop drop: UITextDropRequest) -> UITextDropProposal {
            UITextDropProposal(operation: .cancel)
        }
    }

    final class PasteRefusingTextView: UITextView {
        override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
            if action == #selector(paste(_:)) || action == #selector(pasteAndMatchStyle(_:)) {
                return false
            }
            return super.canPerformAction(action, withSender: sender)
        }

        override func paste(_ sender: Any?) {}
    }
}
