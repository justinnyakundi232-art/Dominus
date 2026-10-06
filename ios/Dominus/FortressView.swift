import SwiftUI
import FamilyControls
import UserNotifications

// The Fortress: what is held, and what an unlock costs.
//
// Apps are picked in Apple's picker and unlocked from the block screen. Sites
// are the extension's: its categories, and sites blocked by hand, each
// unlocked from its row here because the page that blocks it has no buttons.
//
// Every change goes through attempt(). One that only strengthens is made at
// once. One that takes a defence down is shown, line by line, and waits at the
// gate first.
struct FortressView: View {
    @EnvironmentObject private var fortress: Fortress
    @EnvironmentObject private var record: Record
    @EnvironmentObject private var session: Session
    @ObservedObject private var center = AuthorizationCenter.shared

    // One sheet at a time. An editor that asks for something the gate has to
    // see hands over to the gate by changing which of these is showing.
    private enum Sheet: Identifiable {
        case category(FortressPlan.Category?)
        case standards
        case gate(Fortress.Change, Fortress.Cost)

        var id: String {
            switch self {
            case .category(let category): return "category-\(category?.id ?? "new")"
            case .standards: return "standards"
            case .gate: return "gate"
            }
        }
    }

    @State private var sheet: Sheet?
    @State private var pickerShown = false
    @State private var draft = FamilyActivitySelection()
    @State private var typed = ""
    @State private var typedRejected: String?
    @State private var failure: String?

    private let rules = SharedRules.shared

    var body: some View {
        Page("The Fortress") {
            if center.authorizationStatus != .approved {
                permission
            } else {
                if !notificationsAllowed {
                    notificationPermission
                }
                walls
                apps
                if let plan = fortress.plan {
                    ForEach(plan.categories) { category in
                        categoryPanel(category, in: plan)
                    }
                    GoldButton("New category", secondary: true) { sheet = .category(nil) }
                    byHand(plan)
                    standards(plan)
                }
            }
            if let failure = fortress.failure {
                Text(failure)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            plumbing
        }
        // The picker edits a copy. What was chosen is only taken up once it
        // closes, so dropping an app can be made to wait like any other
        // weakening instead of having already happened.
        .familyActivityPicker(isPresented: $pickerShown, selection: $draft)
        .onChange(of: pickerShown) { shown in
            if !shown && draft != fortress.selection {
                attempt(.selection(draft))
            }
        }
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case .category(let category):
                CategoryEditor(
                    original: category,
                    save: { saveCategory($0) },
                    delete: category == nil ? nil : { if let category { deleteCategory(category) } },
                    cancel: { self.sheet = nil }
                )
            case .standards:
                if let plan = fortress.plan {
                    StandardsEditor(
                        plan: plan,
                        save: { task, cooldown in attempt(.edit(.standards(task: task, cooldown: cooldown))) },
                        cancel: { self.sheet = nil }
                    )
                }
            case .gate(let change, let cost):
                PauseGate(
                    lines: cost.lines,
                    changeOnly: cost.changeOnly,
                    seconds: fortress.plan?.removeCooldownSeconds ?? 10,
                    streak: record.standing?.currentStreak ?? 0,
                    confirm: {
                        fortress.perform(change)
                        self.sheet = nil
                    },
                    keep: { self.sheet = nil }
                )
            }
        }
    }

    // Free if it only strengthens; otherwise to the gate.
    private func attempt(_ change: Fortress.Change) {
        let cost = fortress.cost(of: change)
        if cost.isFree {
            fortress.perform(change)
            sheet = nil
        } else {
            sheet = .gate(change, cost)
        }
    }

    // MARK: - What it stands on

    private var notificationsAllowed: Bool {
        switch session.notifications {
        case .authorized, .provisional, .ephemeral: return true
        default: return false
        }
    }

    private var permission: some View {
        Panel("Screen Time") {
            if center.authorizationStatus == .denied {
                // Denied is not final: iOS asks again on the next request, and
                // it can also be turned on in Settings → Screen Time.
                Text("Not allowed. Dominus cannot block anything without it.")
                    .foregroundStyle(Theme.parchment)
                GoldButton("Ask again", action: ask)
            } else {
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
            if session.notifications == .denied {
                Text("Turned off. Unlock on the block screen can't reach you. Turn them on in Settings → Notifications → Dominus.")
                    .foregroundStyle(Theme.parchment)
            } else {
                Text("Unlock on the block screen reaches you through a notification, since the block screen can't open Dominus itself.")
                    .foregroundStyle(Theme.parchment)
                GoldButton("Allow notifications") { session.allowNotifications() }
            }
        }
    }

    // MARK: - The walls

    private var walls: some View {
        Panel("The walls") {
            if fortress.isStanding {
                Text("Standing. Everything below is blocked.")
                    .foregroundStyle(Theme.parchment)
                if fortress.standDown == .none {
                    GoldButton("Take it down", secondary: true) { fortress.requestStandDown() }
                    Text("Asking starts a 30-minute wait you don't have to watch. Nothing changes until you come back and confirm.")
                        .font(.footnote)
                        .foregroundStyle(Theme.goldDim)
                } else {
                    StandDownStatus()
                }
            } else if fortress.isEmpty {
                Text("Nothing to block yet. Choose apps, switch on a category, or block a site by hand.")
                    .foregroundStyle(Theme.parchment)
            } else {
                Text("Down. Nothing is blocked, and changes are free until it is raised.")
                    .foregroundStyle(Theme.parchment)
                GoldButton("Raise it") { fortress.raise() }
            }
        }
    }

    // MARK: - Apps

    // Picked apps, categories and sites come back as tokens: Dominus can show
    // them with Apple's Label but never read which app or site they are. They
    // are unlocked from the block screen.
    private var apps: some View {
        let selection = fortress.selection
        let empty = selection.applicationTokens.isEmpty
            && selection.categoryTokens.isEmpty
            && selection.webDomainTokens.isEmpty

        return Panel("Apps", info: "Chosen in Apple's picker. A blocked app shows the Dominus block screen, and its Unlock button brings you here.") {
            if empty {
                Text("No apps chosen.")
                    .foregroundStyle(Theme.parchment)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(selection.applicationTokens), id: \.self) { Label($0) }
                    ForEach(Array(selection.categoryTokens), id: \.self) { Label($0) }
                    ForEach(Array(selection.webDomainTokens), id: \.self) { Label($0) }
                }
                .foregroundStyle(Theme.parchment)
            }
            GoldButton(empty ? "Choose apps" : "Change apps", secondary: !empty) {
                draft = fortress.selection
                pickerShown = true
            }
        }
    }

    // MARK: - Sites

    private func categoryPanel(_ category: FortressPlan.Category, in plan: FortressPlan) -> some View {
        Panel(category.name) {
            HStack(spacing: 10) {
                Text(category.glyph)
                    .foregroundStyle(Color(hexString: plan.hex(of: category)))
                Text("\(category.sites.count) \(category.sites.count == 1 ? "site" : "sites")")
                    .font(.footnote)
                    .foregroundStyle(Theme.goldDim)
                Spacer()
                // Bound to the stored value, not to a copy: if the gate is
                // turned away from, nothing changed and the switch shows so.
                Toggle("", isOn: Binding(
                    get: { category.enabled },
                    set: { setEnabled(category, $0, in: plan) }
                ))
                .labelsHidden()
                .tint(Theme.gold)
            }
            if category.enabled {
                siteRows(category.sites, remove: nil)
            }
            Button("Edit") { sheet = .category(category) }
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.gold)
        }
    }

    // Sites blocked one at a time, with no category behind them — what the
    // extension's popup calls blocking a site.
    private func byHand(_ plan: FortressPlan) -> some View {
        Panel("Blocked by hand") {
            HStack(spacing: 10) {
                TextField("", text: $typed, prompt: Text("youtube.com").foregroundColor(Theme.goldDim))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.done)
                    .onSubmit { addTyped(to: plan) }
                    .foregroundStyle(Theme.parchment)
                    .padding(12)
                    .background(Theme.panel)
                    .overlay(Rectangle().stroke(Theme.goldDim.opacity(0.4), lineWidth: 1))
                Button("Block") { addTyped(to: plan) }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.gold)
            }
            if let typedRejected {
                Text("\u{201C}\(typedRejected)\u{201D} isn't a site Dominus can block.")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            if plan.manualSites.isEmpty {
                Text("None.")
                    .foregroundStyle(Theme.parchment)
            } else {
                siteRows(plan.manualSites) { site in
                    attempt(.edit(.manualSites(plan.manualSites.filter { $0 != site })))
                }
            }
        }
    }

    // The filter's page for a site blocked by name has no buttons, so its row
    // here is the only way to unlock one.
    private func siteRows(_ sites: [String], remove: ((String) -> Void)?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(sites, id: \.self) { site in
                HStack(spacing: 16) {
                    Text(site)
                        .foregroundStyle(Theme.parchment)
                    Spacer()
                    if fortress.isStanding {
                        if fortress.isOpen(.site(site)) {
                            Text("Open")
                                .font(.footnote)
                                .foregroundStyle(Theme.goldDim)
                        } else {
                            Button("Unlock") { session.begin(.site(site), fromRequest: false) }
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(Theme.gold)
                        }
                    }
                    if let remove {
                        Button {
                            remove(site)
                        } label: {
                            Image(systemName: "xmark")
                                .foregroundStyle(Theme.goldDim)
                        }
                        .accessibilityLabel("Unblock \(site)")
                    }
                }
            }
        }
    }

    // MARK: - What an unlock costs

    private func standards(_ plan: FortressPlan) -> some View {
        Panel("What an unlock costs", info: "First the task, then the cooldown, then the block opens — for one thing, for a while. The same for an app and a site.") {
            VStack(alignment: .leading, spacing: 4) {
                Text(plan.task.map { plan.title(ofTask: $0.type) } ?? "No task")
                    .foregroundStyle(Theme.parchment)
                Text(plan.task == nil ? "An unlock goes straight to the cooldown." : "Then the cooldown.")
                    .font(.footnote)
                    .foregroundStyle(Theme.goldDim)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("\(rules.formatHuman(plan.cooldown.seconds)) cooldown")
                    .foregroundStyle(Theme.parchment)
                Text(plan.cooldown.escalate
                     ? "Growing ×\(String(format: "%.2f", plan.cooldown.factor)) with each unlock of the same thing that day."
                     : "The same every time.")
                    .font(.footnote)
                    .foregroundStyle(Theme.goldDim)
            }
            GoldButton("Change", secondary: true) { sheet = .standards }
        }
    }

    // MARK: - Edits

    private func setEnabled(_ category: FortressPlan.Category, _ enabled: Bool, in plan: FortressPlan) {
        var categories = plan.categories
        guard let index = categories.firstIndex(where: { $0.id == category.id }) else { return }
        categories[index].enabled = enabled
        attempt(.edit(.categories(categories)))
    }

    private func saveCategory(_ category: FortressPlan.Category) {
        guard var categories = fortress.plan?.categories else { return }
        if let index = categories.firstIndex(where: { $0.id == category.id }) {
            categories[index] = category
        } else {
            categories.append(category)
        }
        attempt(.edit(.categories(categories)))
    }

    private func deleteCategory(_ category: FortressPlan.Category) {
        guard let categories = fortress.plan?.categories else { return }
        attempt(.edit(.categories(categories.filter { $0.id != category.id })))
    }

    private func addTyped(to plan: FortressPlan) {
        let raw = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return }
        // Asked of the extension's normalizeDomain() first only so a mistyped
        // site can be refused in words; the save cleans it again regardless.
        guard !rules.normalizeDomain(raw).isEmpty else {
            typedRejected = raw
            return
        }
        typed = ""
        typedRejected = nil
        attempt(.edit(.manualSites(plan.manualSites + [raw])))
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

    // MARK: - Plumbing

    // What every build depends on, stated rather than assumed: the
    // extension's JavaScript, the storage shared with the block screen, and
    // whether the block screen's last notification got through.
    private var plumbing: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(rules.isLoaded
                 ? "Shared rules: the extension's own scripts are running on this phone."
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
}
