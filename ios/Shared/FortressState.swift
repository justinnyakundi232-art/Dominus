import Foundation
import FamilyControls
import ManagedSettings

// The whole fortress, as one value in the App Group.
//
// It lives there rather than in the app's own storage because the app is not
// the only thing that has to act on it: DominusMonitor wakes when an unlock
// runs out and has to put the block back, and it can only rebuild what it can
// read.
//
// What is enforced is always rebuilt from this, never edited in place — the
// same rule as the extension's blockedSites, which is re-derived after every
// change rather than synced, so what is blocked cannot drift from what is
// shown.
struct FortressState: Codable {
    var raised = false
    var selection = FamilyActivitySelection()
    var sites: [String] = []
    var unlocks: [Unlock] = []
    var slips: [Slip] = []

    struct Unlock: Codable, Identifiable {
        let id: String          // also the DeviceActivity name that ends it
        let target: LockTarget
        let until: Date
    }

    // An unlock is a slip, as in Chrome. Kept as times for the same reason
    // stands are: escalation and the day log are counted from dates.
    struct Slip: Codable {
        let key: String
        let at: Date
    }

    private static let key = "fortress.state"

    static func load() -> FortressState? {
        Gate.defaults?.data(forKey: key)
            .flatMap { try? JSONDecoder().decode(FortressState.self, from: $0) }
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) {
            Gate.defaults?.set(data, forKey: Self.key)
        }
    }

    func liveUnlocks(at now: Date) -> [Unlock] {
        unlocks.filter { $0.until > now }
    }

    // Drops unlocks that have run out and returns them, so whoever pruned can
    // stop the timers that belonged to them. `slack` lets DominusMonitor treat
    // an unlock ending within the minute as ended: its timer is rounded up to
    // a whole minute, and waking a few seconds early must still re-block.
    mutating func pruneExpired(at now: Date, slack: TimeInterval = 0) -> [Unlock] {
        let ended = unlocks.filter { $0.until <= now.addingTimeInterval(slack) }
        unlocks.removeAll { $0.until <= now.addingTimeInterval(slack) }
        slips.removeAll { $0.at < now.addingTimeInterval(-30 * 24 * 60 * 60) }
        return ended
    }

    // Unlocks of this same thing earlier today — what escalation multiplies
    // by. Local day, as everywhere in Dominus: a slip at 1am belongs to the
    // day it felt like.
    func unlocksToday(of target: LockTarget, now: Date = Date()) -> Int {
        let key = target.key
        return slips.filter { $0.key == key && Calendar.current.isDate($0.at, inSameDayAs: now) }.count
    }

    // Writes everything that should be blocked right now, minus whatever is
    // open. Empty sets are written as nil: nil is "no rule".
    func apply(to store: ManagedSettingsStore, at now: Date = Date()) {
        guard raised else {
            store.clearAllSettings()
            return
        }

        var apps = selection.applicationTokens
        var categories = selection.categoryTokens
        var domains = selection.webDomainTokens
        var openApps = Set<ApplicationToken>()
        var openDomains = Set<WebDomainToken>()
        var openSites = Set<String>()

        for unlock in liveUnlocks(at: now) {
            switch unlock.target {
            case .application(let token):
                apps.remove(token)
                // An app blocked only because its category is picked is
                // opened as an exception to the category.
                openApps.insert(token)
            case .webDomain(let token):
                domains.remove(token)
                openDomains.insert(token)
            case .category(let token):
                categories.remove(token)
            case .site(let domain):
                openSites.insert(domain)
            }
        }

        store.shield.applications = apps.isEmpty ? nil : apps
        store.shield.applicationCategories = categories.isEmpty ? nil : .specific(categories, except: openApps)
        store.shield.webDomains = domains.isEmpty ? nil : domains
        // A picked category covers its websites as well as its apps, the way
        // a category in the extension covers every site in it.
        store.shield.webDomainCategories = categories.isEmpty ? nil : .specific(categories, except: openDomains)

        let blocked = sites.filter { !openSites.contains($0) }
        store.webContent.blockedByFilter = blocked.isEmpty
            ? nil
            : .specific(Set(blocked.map { WebDomain(domain: $0) }))
    }
}
