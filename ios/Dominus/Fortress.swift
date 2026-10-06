import Foundation
import DeviceActivity
import FamilyControls
import ManagedSettings
import UserNotifications

// The app's handle on the fortress: what is held, whether it is standing, and
// what is open for now.
//
// It is kept in two places, for two readers.
//
//   - The plan — categories, sites blocked by hand, the unlock task, the
//     cooldown — is the extension's, stored in its shape and read and written
//     through Seal.js. It is what a peer will one day merge.
//   - FortressState is what this phone enforces: the apps picked in Apple's
//     picker, which mean nothing off this phone; the block list derived from
//     the plan; whether the fortress is raised; and what is open. It lives in
//     the App Group as one value because DominusMonitor has to rebuild the
//     blocks from it without the app, or JavaScript, to help.
//
// Strengthening is free. Anything that takes a defence down is named first,
// by cost(of:), so that whoever is about to do it can be shown what they are
// giving up and made to wait.
@MainActor
final class Fortress: ObservableObject {
    @Published private var state: FortressState
    @Published private(set) var plan: FortressPlan?
    @Published private(set) var failure: String?
    @Published private(set) var standDown: StandDown = .none

    private let store = ManagedSettingsStore()
    private let rules = SharedRules.shared

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
        readPlan()
        readStandDown()
        enforce()
        stopTimers(for: ended)
    }

    // For a clock tick while the app is open: an unlock that runs out in
    // front of you ends in front of you, not whenever the timer lands, and a
    // request to take the fortress down becomes ready, or lapses, on time.
    func refreshIfAnyEnded() {
        if state.unlocks.contains(where: { $0.until <= Date() }) {
            refresh()
        } else if state.standDownRequestedAt != nil {
            let before = standDown
            readStandDown()
            if standDown != before {
                state.save()
            }
        }
    }

    // MARK: - What is held

    var selection: FamilyActivitySelection { state.selection }
    var sites: [String] { state.sites }
    var isStanding: Bool { state.raised }

    var isEmpty: Bool {
        state.selection.applicationTokens.isEmpty
            && state.selection.categoryTokens.isEmpty
            && state.selection.webDomainTokens.isEmpty
            && state.sites.isEmpty
    }

    // The plan, and the block list it comes to. The list is copied into
    // FortressState the way the extension keeps blockedSites beside its
    // categories: derived every time, never edited, so what is enforced
    // cannot drift from what is shown.
    private func readPlan() {
        // Before the very first read only: see carryOverSites().
        rules.carryOverSites(state.sites)

        switch rules.fortress() {
        case .success(let data):
            do {
                let plan = try JSONDecoder().decode(FortressPlan.self, from: data)
                self.plan = plan
                state.sites = plan.blockedSites
                failure = nil
            } catch {
                failure = "Dominus couldn't read the fortress: \(error.localizedDescription)"
            }
        case .failure(let problem):
            failure = problem.message
        }
    }

    // MARK: - Changing it

    // Something that would change what is held. Edits to the plan go through
    // the extension's code; the picked apps exist only on a phone. Taking the
    // whole fortress down is not one of these: it has a slower road of its
    // own, below.
    enum Change {
        case edit(FortressEdit)
        case selection(FamilyActivitySelection)
    }

    // What a change costs: what it gives up, one line each, and whether that
    // is a taking down or only a change.
    struct Cost {
        var lines: [String]
        // Swapping one unlock task for another waits like a weakening, since
        // it could be one, but is not announced as one. See __dominusReview().
        var changeOnly = false

        var isFree: Bool { lines.isEmpty }
    }

    // Free means it only strengthens, and may simply be made.
    //
    // For an edit the lines are describeWeakening()'s own, so the phone says
    // what Chrome's seal prompt would say. A fortress that is down defends
    // nothing, so nothing done to it is a weakening — the same reasoning the
    // extension applies to a category that is switched off.
    func cost(of change: Change) -> Cost {
        guard isStanding else { return Cost(lines: []) }

        switch change {
        case .edit(let edit):
            struct Review: Decodable {
                let weakenings: [String]
                let changeOnly: Bool
            }
            guard
                case .success(let data) = rules.review(edit.data),
                let review = try? JSONDecoder().decode(Review.self, from: data)
            else {
                // Unchecked is not the same as harmless.
                return Cost(lines: ["Dominus couldn't check what this changes, so it is treated as taking a defence down."])
            }
            return Cost(lines: review.weakenings, changeOnly: review.changeOnly)

        case .selection(let next):
            var lines: [String] = []
            let apps = state.selection.applicationTokens.subtracting(next.applicationTokens).count
            let categories = state.selection.categoryTokens.subtracting(next.categoryTokens).count
            let sites = state.selection.webDomainTokens.subtracting(next.webDomainTokens).count
            if apps > 0 {
                lines.append("\(apps) \(apps == 1 ? "app" : "apps") removed — \(apps == 1 ? "it stops" : "they stop") being blocked.")
            }
            if categories > 0 {
                lines.append("\(categories) app \(categories == 1 ? "category" : "categories") removed — everything in \(categories == 1 ? "it" : "them") stops being blocked.")
            }
            if sites > 0 {
                lines.append("\(sites) picked \(sites == 1 ? "site" : "sites") removed — \(sites == 1 ? "it stops" : "they stop") being blocked.")
            }
            return Cost(lines: lines)
        }
    }

    // Makes the change. Whether it may be made is settled before this.
    func perform(_ change: Change) {
        switch change {
        case .edit(let edit):
            if case .failure(let problem) = rules.commit(edit.data) {
                failure = problem.message
            }
            readPlan()
            enforce()

        case .selection(let next):
            state.selection = next
            enforce()
        }
    }

    func raise() {
        state.raised = true
        enforce()
    }

    // MARK: - Taking the whole fortress down

    // The extension has no switch for this: there, blocks come down one at a
    // time, each through its own gate. On the phone one button lifts
    // everything, so it is the slowest thing in the app.
    //
    //   - Asking changes nothing. The fortress stays up, whole, for
    //     standDownDelay — thirty minutes that do not have to be watched,
    //     which is why they can be thirty.
    //   - It never falls by itself. When the wait is over it has to be
    //     confirmed, here, by someone who still wants it: an impulse at
    //     eleven should not take the fortress down at half past whether or
    //     not it has passed.
    //   - The offer lapses after standDownWindow, so a request cannot be
    //     made in advance and held in reserve.
    //   - Calling it off is strengthening, and free, at any point.
    //
    // None of this is a lock. One thing can still be unlocked at its usual
    // cost in the meantime, and deleting Dominus, or turning off its Screen
    // Time access, lifts everything at once and always will.
    enum StandDown: Equatable {
        case none
        case waiting(until: Date)
        case ready(until: Date)
    }

    func requestStandDown() {
        guard isStanding, state.standDownRequestedAt == nil else { return }
        state.standDownRequestedAt = Date()
        readStandDown()
        state.save()
        notifyWhenStandDownIsReady()
    }

    func cancelStandDown() {
        clearStandDown()
        state.save()
    }

    // Only once the wait is over and before the offer lapses. Also closes
    // anything open: a fortress raised again later starts whole.
    func confirmStandDown() {
        readStandDown()
        guard case .ready = standDown else { return }

        let ended = state.unlocks
        state.raised = false
        state.unlocks = []
        clearStandDown()
        enforce()
        stopTimers(for: ended)
    }

    // Where a request stands as of now. One that has lapsed, or that outlived
    // the fortress it was about, is cleared.
    private func readStandDown() {
        guard let asked = state.standDownRequestedAt, state.raised else {
            if state.standDownRequestedAt != nil {
                clearStandDown()
            } else {
                standDown = .none
            }
            return
        }

        let now = Date()
        let ready = asked.addingTimeInterval(FortressState.standDownDelay)
        let lapses = ready.addingTimeInterval(FortressState.standDownWindow)

        if now < ready {
            standDown = .waiting(until: ready)
        } else if now < lapses {
            standDown = .ready(until: lapses)
        } else {
            clearStandDown()
        }
    }

    private func clearStandDown() {
        state.standDownRequestedAt = nil
        standDown = .none
        UNUserNotificationCenter.current()
            .removePendingNotificationRequests(withIdentifiers: [Fortress.standDownNotification])
    }

    private static let standDownNotification = "dominus.standdown"

    // Says when the wait is over, since nobody is meant to be watching it.
    // Without notifications allowed nothing arrives, and the request is
    // simply found ready the next time Dominus is opened.
    private func notifyWhenStandDownIsReady() {
        let content = UNMutableNotificationContent()
        content.title = "The fortress can come down now"
        content.body = "Open Dominus within the hour to confirm, or leave it standing."
        content.sound = .default

        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: FortressState.standDownDelay, repeats: false)
        let request = UNNotificationRequest(
            identifier: Fortress.standDownNotification,
            content: content,
            trigger: trigger
        )
        UNUserNotificationCenter.current().add(request)
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

    // The task and cooldown that govern unlocking this. A site's category may
    // set its own; an app has no name to look up and takes the fortress's.
    func standards(for target: LockTarget) -> Standards? {
        guard case .success(let data) = rules.standards(for: target.domain) else { return nil }
        return try? JSONDecoder().decode(Standards.self, from: data)
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

    // Opens one thing for its window and notes it for escalation. The timer
    // that ends it is started first: an unlock with nothing to close it would
    // be a block quietly gone for good, so if the timer cannot be set, nothing
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
        enforce()
    }

    // Closing early is strengthening, so it is free.
    func close(_ unlock: FortressState.Unlock) {
        state.unlocks.removeAll { $0.id == unlock.id }
        enforce()
        stopTimers(for: [unlock])
    }

    // MARK: - Enforcement

    private func enforce() {
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
