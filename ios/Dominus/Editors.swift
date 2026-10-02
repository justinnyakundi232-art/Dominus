import SwiftUI

// The two places the fortress's plan is edited. Neither saves anything
// itself: each hands back what was chosen, and The Fortress decides whether it
// may simply be made or has to wait at the gate first.

// One category: its name and its sites.
struct CategoryEditor: View {
    let original: FortressPlan.Category?
    let save: (FortressPlan.Category) -> Void
    let delete: (() -> Void)?
    let cancel: () -> Void

    @State private var name: String
    @State private var sites: String

    init(
        original: FortressPlan.Category?,
        save: @escaping (FortressPlan.Category) -> Void,
        delete: (() -> Void)?,
        cancel: @escaping () -> Void
    ) {
        self.original = original
        self.save = save
        self.delete = delete
        self.cancel = cancel
        _name = State(initialValue: original?.name ?? "")
        _sites = State(initialValue: (original?.sites ?? []).joined(separator: "\n"))
    }

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // One per line, or separated by commas — whatever was pasted. Cleaning
    // each into a bare domain, and dropping what cannot be one, is left to the
    // extension's parseSiteList() when the edit is saved.
    private var siteList: [String] {
        sites
            .components(separatedBy: CharacterSet(charactersIn: "\n,"))
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    var body: some View {
        Page(original == nil ? "New category" : "Edit category") {
            Panel("Name") {
                TextField("", text: $name, prompt: Text("News").foregroundColor(Theme.goldDim))
                    .foregroundStyle(Theme.parchment)
                    .padding(12)
                    .background(Theme.panel)
                    .overlay(Rectangle().stroke(Theme.goldDim.opacity(0.4), lineWidth: 1))
            }

            Panel("Sites") {
                Text("One site per line. A pasted address is trimmed to the site's name.")
                    .font(.footnote)
                    .foregroundStyle(Theme.goldDim)
                TextEditor(text: $sites)
                    .scrollContentBackground(.hidden)
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(Theme.parchment)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .frame(minHeight: 180)
                    .padding(8)
                    .background(Theme.panel)
                    .overlay(Rectangle().stroke(Theme.goldDim.opacity(0.4), lineWidth: 1))
            }

            GoldButton("Save") {
                var category = original ?? FortressPlan.Category(name: trimmedName, sites: siteList)
                category.name = trimmedName
                category.sites = siteList
                save(category)
            }
            .disabled(trimmedName.isEmpty)
            .opacity(trimmedName.isEmpty ? 0.4 : 1)

            GoldButton("Cancel", secondary: true, action: cancel)

            if let delete {
                Button("Delete this category", action: delete)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 8)
            }
        }
    }
}

// The unlock task and the cooldown: what an unlock costs.
struct StandardsEditor: View {
    let plan: FortressPlan
    let save: (FortressPlan.UnlockTask?, FortressPlan.Cooldown) -> Void
    let cancel: () -> Void

    private static let none = "none"

    @State private var type: String
    @State private var message: String
    @State private var code: String
    // A code is shown once, when it is made. One that is already set is not
    // shown again: the only copy is meant to be the one that was written down.
    @State private var codeIsNew = false

    @State private var seconds: Int
    @State private var escalate: Bool
    @State private var factor: Double

    private let rules = SharedRules.shared

    init(
        plan: FortressPlan,
        save: @escaping (FortressPlan.UnlockTask?, FortressPlan.Cooldown) -> Void,
        cancel: @escaping () -> Void
    ) {
        self.plan = plan
        self.save = save
        self.cancel = cancel
        _type = State(initialValue: plan.task?.type ?? StandardsEditor.none)
        _message = State(initialValue: plan.task?.message ?? "")
        _code = State(initialValue: plan.task?.code ?? "")
        _seconds = State(initialValue: plan.cooldown.seconds)
        _escalate = State(initialValue: plan.cooldown.escalate)
        _factor = State(initialValue: plan.cooldown.factor)
    }

    private var trimmedMessage: String {
        message.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // "No task" is a real choice, so it cannot also be what an unfinished
    // one looks like.
    private enum Choice {
        case unfinished
        case task(FortressPlan.UnlockTask?)
    }

    private var choice: Choice {
        switch type {
        case StandardsEditor.none:
            return .task(nil)
        case "cooldown":
            return trimmedMessage.isEmpty ? .unfinished : .task(FortressPlan.UnlockTask.reflection(trimmedMessage))
        case "passage":
            return .task(FortressPlan.UnlockTask.passage)
        case "code":
            return code.isEmpty ? .unfinished : .task(FortressPlan.UnlockTask.code(code))
        default:
            // A task type this version doesn't know is kept as it is.
            return .task(plan.task)
        }
    }

    private var unfinished: Bool {
        if case .unfinished = choice { return true }
        return false
    }

    var body: some View {
        Page("What an unlock costs") {
            Panel("The task") {
                option(StandardsEditor.none, title: "No task", detail: "An unlock goes straight to the cooldown.")
                ForEach(plan.taskTypes) { task in
                    option(task.id, title: task.title, detail: task.tooltip)
                }

                if type == "cooldown" {
                    Text("Your message, written now, while you are thinking clearly:")
                        .font(.footnote)
                        .foregroundStyle(Theme.goldDim)
                    TextEditor(text: $message)
                        .scrollContentBackground(.hidden)
                        .foregroundStyle(Theme.parchment)
                        .frame(minHeight: 110)
                        .padding(8)
                        .background(Theme.panel)
                        .overlay(Rectangle().stroke(Theme.goldDim.opacity(0.4), lineWidth: 1))
                }

                if type == "code" {
                    if codeIsNew {
                        Text(code)
                            .font(.system(.title, design: .monospaced).weight(.bold))
                            .tracking(4)
                            .foregroundStyle(Theme.gold)
                            .padding(14)
                            .frame(maxWidth: .infinity)
                            .background(Theme.panel)
                        Text("Write this down and leave it somewhere inconvenient. Dominus will not show it again.")
                            .font(.footnote)
                            .foregroundStyle(Theme.parchment)
                    } else {
                        Text("A code is already set. It isn't shown again.")
                            .font(.footnote)
                            .foregroundStyle(Theme.parchment)
                    }
                    Button("Make a new code", action: newCode)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.gold)
                }
            }

            Panel("The cooldown") {
                Stepper(value: $seconds, in: plan.minCooldownSeconds...plan.maxCooldownSeconds, step: 30) {
                    Text(rules.formatHuman(seconds))
                        .foregroundStyle(Theme.parchment)
                }
                Toggle(isOn: $escalate) {
                    Text("Grow with each unlock")
                        .foregroundStyle(Theme.parchment)
                }
                .tint(Theme.gold)
                if escalate {
                    Stepper(value: $factor, in: plan.minEscalationFactor...3, step: 0.25) {
                        Text("×\(String(format: "%.2f", factor)) each time")
                            .foregroundStyle(Theme.parchment)
                    }
                    Text("Each unlock of the same thing on the same day waits that much longer than the last, up to \(rules.formatHuman(plan.maxCooldownSeconds)).")
                        .font(.footnote)
                        .foregroundStyle(Theme.goldDim)
                }
            }

            GoldButton("Save") {
                if case .task(let task) = choice {
                    save(task, FortressPlan.Cooldown(seconds: seconds, escalate: escalate, factor: factor))
                }
            }
            .disabled(unfinished)
            .opacity(unfinished ? 0.4 : 1)

            GoldButton("Cancel", secondary: true, action: cancel)
        }
    }

    private func option(_ id: String, title: String, detail: String) -> some View {
        Button {
            type = id
            // Choosing Guarded Code with no code yet makes one.
            if id == "code" && code.isEmpty {
                newCode()
            }
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: type == id ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(Theme.gold)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .foregroundStyle(Theme.parchment)
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(Theme.goldDim)
                        .multilineTextAlignment(.leading)
                }
            }
        }
    }

    private func newCode() {
        code = rules.generateGuardCode()
        codeIsNew = true
    }
}
