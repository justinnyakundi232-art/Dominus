import SwiftUI
import FamilyControls

// The unlock, as the extension's blocked page runs it: the task, then the
// cooldown, then a last word before anything opens.
//
//   - The task is whichever the fortress sets, in the blocked page's own
//     words and checked the way it checks them: Reflection Message and Random
//     Passage are typed back exactly (trimmed, then compared), with pasting
//     refused; Guarded Code is typed from the paper it was written on, in
//     either case. With no task set, the unlock goes straight to the cooldown.
//   - The cooldown is Tasks.js's effectiveCooldownSeconds() over the
//     fortress's settings, escalating with each unlock of the same thing
//     today if it is set to. Leaving Dominus starts it over: the wait is the
//     friction, and a wait spent elsewhere isn't one.
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

    // What has to be done before the cooldown starts.
    private enum Challenge {
        case none
        case typing(instruction: String, target: String, sentences: Bool)
        case code(expected: String)
    }

    private let challenge: Challenge
    private let cooldownSettings: [String: Any]

    @State private var step: Step = .task
    @State private var typed = ""
    @State private var now = Date()
    @State private var leftDuringCooldown = false
    @State private var startedOver = false
    @State private var failure: String?

    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    init(target: LockTarget, fortress: Fortress, record: Record, done: @escaping () -> Void) {
        self.target = target
        _fortress = ObservedObject(wrappedValue: fortress)
        _record = ObservedObject(wrappedValue: record)
        self.done = done

        // Read once, as the unlock begins: the standards that govern it should
        // not change underneath someone halfway through.
        let standards = fortress.standards(for: target)
        cooldownSettings = standards?.cooldown.dictionary ?? ["seconds": 60, "escalate": false, "factor": 1.25]

        // The same routing as the blocked page's beginTask(), including its
        // two escapes: a task of a type this version doesn't know, or a code
        // task saved without a code, must not become a lock with no key.
        switch standards?.task?.type ?? "" {
        case "cooldown" where standards?.task?.message.isEmpty == false:
            // The user's own words, written with a keyboard that capitalises
            // sentences, so they are typed back with one that does too.
            challenge = .typing(
                instruction: "Type the message below exactly to begin your cooldown:",
                target: standards?.task?.message ?? "",
                sentences: true
            )
        case "passage":
            challenge = .typing(
                instruction: "Type this passage exactly to begin your cooldown:",
                target: SharedRules.shared.generatePassage(),
                sentences: false
            )
        case "code" where standards?.task?.code.isEmpty == false:
            challenge = .code(expected: standards?.task?.code ?? "")
        default:
            challenge = .none
        }
    }

    private var seconds: Int {
        SharedRules.shared.effectiveCooldownSeconds(
            cooldownSettings,
            priorUnlocks: fortress.unlocksToday(of: target)
        )
    }

    var body: some View {
        ZStack {
            Theme.ground.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Text("UNLOCK")
                        .font(.display(34, relativeTo: .largeTitle))
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
        .onAppear {
            // No task set: the cooldown is the whole of the cost.
            if case .none = challenge, step == .task {
                startCooldown()
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

    @ViewBuilder
    private var task: some View {
        switch challenge {
        case .none:
            EmptyView()

        case .typing(let instruction, let target, let sentences):
            VStack(alignment: .leading, spacing: 14) {
                Text(instruction)
                    .foregroundStyle(Theme.parchment)
                Text(target)
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(Theme.gold)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.panel)
                typingBox(sentences: sentences) { value in
                    Self.plain(value) == Self.plain(target)
                }
                // The blocked page says so when CONFIRM is pressed on a
                // mismatch. Here the cooldown starts by itself on a match, so
                // without this a wrong capital looks like a frozen screen. It
                // shows at the first character that goes astray, rather than
                // after the whole thing has been typed in vain.
                if !Self.plain(target).hasPrefix(Self.plain(typed)) {
                    Text("That doesn't match. Check the capitals and the punctuation.")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
                Text("Pasting is disabled.")
                    .font(.footnote)
                    .foregroundStyle(Theme.goldDim)
            }

        case .code(let expected):
            VStack(alignment: .leading, spacing: 14) {
                Text("Enter the code you wrote down:")
                    .foregroundStyle(Theme.parchment)
                // Case-insensitive, as on the blocked page: the friction is
                // fetching the paper, not remembering how it was written.
                typingBox(sentences: false) { value in
                    value.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
                        == expected.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
                }
                Text("The code isn't shown here. The only copy is the one you wrote down.")
                    .font(.footnote)
                    .foregroundStyle(Theme.goldDim)
            }
        }
    }

    // What is compared: the text with the differences a phone keyboard makes
    // by itself taken out. The blocked page compares trimmed text exactly, and
    // so does this for every letter and its case. But a message may have been
    // written where the keyboard curls its quotes and joins its dashes — on
    // this phone before that was switched off, or one day in Chrome — and
    // typed back where it does not. Those are the same sentence, and a task
    // that cannot be completed is a lock with no key.
    private static func plain(_ text: String) -> String {
        let folded = text
            .replacingOccurrences(of: "\u{2018}", with: "'")
            .replacingOccurrences(of: "\u{2019}", with: "'")
            .replacingOccurrences(of: "\u{201C}", with: "\"")
            .replacingOccurrences(of: "\u{201D}", with: "\"")
            .replacingOccurrences(of: "\u{2013}", with: "-")
            .replacingOccurrences(of: "\u{2014}", with: "-")
            .replacingOccurrences(of: "\u{2026}", with: "...")
            .replacingOccurrences(of: "\u{00A0}", with: " ")
        // Any run of spaces or line breaks is one space: the box that is
        // typed into has no Return key to make a line break with.
        return folded
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    // The cooldown begins the moment what is typed matches.
    private func typingBox(sentences: Bool, matches: @escaping (String) -> Bool) -> some View {
        NoPasteField(text: $typed, sentences: sentences)
            .background(Theme.panel)
            .overlay(Rectangle().stroke(Theme.goldDim.opacity(0.4), lineWidth: 1))
            .onChange(of: typed) { value in
                if matches(value) {
                    startCooldown()
                }
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
        let escalating = (cooldownSettings["escalate"] as? Bool) == true
        return VStack(alignment: .leading, spacing: 14) {
            Text(SharedRules.shared.formatClock(remaining))
                .font(.display(64))
                .monospacedDigit()
                .foregroundStyle(Theme.gold)
            Text(startedOver
                 ? "You left Dominus, so the cooldown started over. Stay here until it ends."
                 : "Stay here until it ends. Leaving Dominus starts it over.")
                .foregroundStyle(Theme.parchment)
            if prior > 0 && escalating {
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
    // Capital at the start of a sentence, as a keyboard does for prose. Off
    // for a passage or a code, which have none.
    var sentences = false
    // The same plain keyboard is used to write a Reflection Message as to
    // type it back, so nothing is written that cannot be typed. There,
    // pasting is your own words and is allowed.
    var refusesPaste = true

    func makeUIView(context: Context) -> UITextView {
        let view = PasteRefusingTextView()
        view.refusesPaste = refusesPaste
        view.delegate = context.coordinator
        view.textDropDelegate = context.coordinator
        view.backgroundColor = .clear
        view.textColor = UIColor(red: 0xE5 / 255, green: 0xE5 / 255, blue: 0xE5 / 255, alpha: 1)
        view.tintColor = UIColor(red: 0xD4 / 255, green: 0xAF / 255, blue: 0x37 / 255, alpha: 1)
        view.font = .monospacedSystemFont(ofSize: 17, weight: .regular)
        view.textContainerInset = UIEdgeInsets(top: 12, left: 8, bottom: 12, right: 8)
        // Not scrolling is what lets it report its own height and grow.
        view.isScrollEnabled = false
        view.autocapitalizationType = sentences ? .sentences : .none
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
            let refuses = (textDroppableView as? PasteRefusingTextView)?.refusesPaste ?? true
            return UITextDropProposal(operation: refuses ? .cancel : .copy)
        }
    }

    final class PasteRefusingTextView: UITextView {
        var refusesPaste = true

        override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
            if refusesPaste && (action == #selector(paste(_:)) || action == #selector(pasteAndMatchStyle(_:))) {
                return false
            }
            return super.canPerformAction(action, withSender: sender)
        }

        override func paste(_ sender: Any?) {
            if !refusesPaste {
                super.paste(sender)
            }
        }
    }
}
