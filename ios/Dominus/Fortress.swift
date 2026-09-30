import Foundation
import DeviceActivity
import FamilyControls
import ManagedSettings

// The app's handle on FortressState: what is chosen, what is typed, whether it
// is standing, and what is open for now.
//
// Picked things are shielded and reach Dominus's block screen; sites typed by
// name are stopped by the web content filter, whose page has no buttons, so
// they are unlocked from here. Either way the unlock itself runs in the app,
// and DominusMonitor puts the block back when its time is up.
//
// Taking the whole fortress down is still free. The cost is on opening one
// thing while the rest stands, which is the moment the extension guards too.
@MainActor
final class Fortress: ObservableObject {
    @Published private var state: FortressState

    private let store = ManagedSettingsStore()

    init() {
        state = FortressState.load() ?? Fortress.fromBuild3()
        refresh()
    }

    // Builds 2 and 3 kept the choices in the app's own storage and read
    // "standing" back from the store. Carried over once, so an update does not
    // quietly empty a fortress that was up.
    private static func fromBuild3() -> FortressState {
        let old = UserDefaults.standard
        var state = FortressState()
        if let data = old.data(forKey: "fortress.selection"),
           let selection = try? JSONDecoder().decode(FamilyActivitySelection.self, from: data) {
            state.selection = selection
        }
        state.sites = old.stringArray(forKey: "fortress.sites") ?? []
        let store = ManagedSettingsStore()
        state.raised = store.shield.applications != nil
            || store.shield.applicationCategories != nil
            || store.shield.webDomains != nil
            || store.webContent.blockedByFilter != nil
        state.save()
        return state
    }

    // Re-read, since DominusMonitor may have changed it while the app was
    // away, drop whatever has run out, and enforce the result. Called when the
    // app comes to the front, so an unlock never outlives its time just
    // because a timer was late.
    func refresh() {
        state = FortressState.load() ?? state
        let ended = state.pruneExpired(at: Date())
        commit()
        stopTimers(for: ended)
    }

    // For a clock tick while the app is open: an unlock that runs out in
    // front of you ends in front of you, not whenever the timer lands.
    func refreshIfAnyEnded() {
        if state.unlocks.contains(where: { $0.until <= Date() }) {
            refresh()
        }
    }

    // MARK: - What is held

    var selection: FamilyActivitySelection {
        get { state.selection }
        set {
            state.selection = newValue
            commit()
        }
    }

    var sites: [String] { state.sites }
    var isStanding: Bool { state.raised }

    var isEmpty: Bool {
        state.selection.applicationTokens.isEmpty
            && state.selection.categoryTokens.isEmpty
            && state.selection.webDomainTokens.isEmpty
            && state.sites.isEmpty
    }

    // Returns the domain as stored, or nil if it could not be a site.
    @discardableResult
    func addSite(_ raw: String) -> String? {
        let domain = SharedRules.shared.normalizeDomain(raw)
        guard !domain.isEmpty else { return nil }
        if !state.sites.contains(domain) {
            state.sites.append(domain)
            commit()
        }
        return domain
    }

    // Built up and committed once, so a whole category is one save and one
    // apply rather than one per site.
    func addSites(_ list: [String]) {
        var next = state.sites
        for raw in list {
            let domain = SharedRules.shared.normalizeDomain(raw)
            if !domain.isEmpty && !next.contains(domain) {
                next.append(domain)
            }
        }
        if next != state.sites {
            state.sites = next
            commit()
        }
    }

    func removeSite(_ domain: String) {
        state.sites.removeAll { $0 == domain }
        let ended = state.unlocks.filter { $0.target == .site(domain) }
        state.unlocks.removeAll { $0.target == .site(domain) }
        commit()
        stopTimers(for: ended)
    }

    func raise() {
        state.raised = true
        commit()
    }

    // Also closes anything open: a fortress raised again later starts whole.
    func standDown() {
        let ended = state.unlocks
        state.raised = false
        state.unlocks = []
        commit()
        stopTimers(for: ended)
    }

    // MARK: - What is open

    var openUnlocks: [FortressState.Unlock] {
        state.liveUnlocks(at: Date())
    }

    func isOpen(_ target: LockTarget) -> Bool {
        openUnlocks.contains { $0.target == target }
    }

    func unlocksToday(of target: LockTarget) -> Int {
        state.unlocksToday(of: target)
    }

    var slipsToday: Int {
        state.slips.filter { Calendar.current.isDateInToday($0.at) }.count
    }

    enum UnlockError: LocalizedError {
        case timer(Error)

        var errorDescription: String? {
            switch self {
            case .timer(let error):
                return "Dominus couldn't set the timer that puts the block back, so nothing was unlocked. \(error.localizedDescription)"
            }
        }
    }

    // Opens one thing for its window and records the slip. The timer that
    // ends it is started first: an unlock with nothing to close it would be a
    // block quietly gone for good, so if the timer cannot be set, nothing
    // opens.
    func unlock(_ target: LockTarget) throws {
        let now = Date()
        let until = now.addingTimeInterval(target.window)
        let id = "unlock.\(UUID().uuidString)"

        do {
            try startTimer(named: id, from: now, until: until)
        } catch {
            throw UnlockError.timer(error)
        }

        state.unlocks.removeAll { $0.target == target }
        state.unlocks.append(FortressState.Unlock(id: id, target: target, until: until))
        state.slips.append(FortressState.Slip(key: target.key, at: now))
        commit()
    }

    // Closing early is strengthening, so it is free.
    func close(_ unlock: FortressState.Unlock) {
        state.unlocks.removeAll { $0.id == unlock.id }
        commit()
        stopTimers(for: [unlock])
    }

    // MARK: - Enforcement

    private func commit() {
        state.save()
        state.apply(to: store)
    }

    // DeviceActivity refuses intervals under 15 minutes, and an app's window
    // is exactly 15, so the end is rounded up to the next whole minute rather
    // than risked a second short. The block comes back within a minute of the
    // time shown; opening Dominus before then re-blocks on the spot.
    private func startTimer(named id: String, from start: Date, until end: Date) throws {
        let calendar = Calendar.current
        let roundedEnd = calendar.nextDate(
            after: end,
            matching: DateComponents(second: 0),
            matchingPolicy: .nextTime
        ) ?? end.addingTimeInterval(60)
        let parts: Set<Calendar.Component> = [.year, .month, .day, .hour, .minute, .second]

        let schedule = DeviceActivitySchedule(
            intervalStart: calendar.dateComponents(parts, from: start),
            intervalEnd: calendar.dateComponents(parts, from: roundedEnd),
            repeats: false
        )
        try DeviceActivityCenter().startMonitoring(DeviceActivityName(id), during: schedule)
    }

    private func stopTimers(for unlocks: [FortressState.Unlock]) {
        guard !unlocks.isEmpty else { return }
        DeviceActivityCenter().stopMonitoring(unlocks.map { DeviceActivityName($0.id) })
    }
}
