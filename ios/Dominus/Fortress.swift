import Foundation
import FamilyControls
import ManagedSettings

// What is chosen, what is typed, and whether it is standing.
//
// Build 2 has two ways of naming a site on purpose, because they block
// differently and the difference decides how the extension's categories reach
// the phone:
//
//   - picked in Apple's picker — a token. Shielded, which means the Screen
//     Time screen with a button, and later a Dominus screen of our own.
//   - typed by name — a WebDomain. Blocked by the web content filter, which
//     is what a category's site list would have to use, since those are names
//     and never tokens.
//
// Nothing here costs anything to take down yet. The cooldown, the task and the
// seal come once blocking itself is proven.
@MainActor
final class Fortress: ObservableObject {
    @Published var selection: FamilyActivitySelection {
        didSet { changed() }
    }
    @Published private(set) var sites: [String] {
        didSet { changed() }
    }
    @Published private(set) var isStanding: Bool

    private let store = ManagedSettingsStore()
    private let defaults = UserDefaults.standard

    private enum Key {
        static let selection = "fortress.selection"
        static let sites = "fortress.sites"
    }

    init() {
        let saved = UserDefaults.standard.data(forKey: Key.selection)
            .flatMap { try? JSONDecoder().decode(FamilyActivitySelection.self, from: $0) }
        _selection = Published(initialValue: saved ?? FamilyActivitySelection())
        _sites = Published(initialValue: UserDefaults.standard.stringArray(forKey: Key.sites) ?? [])

        // The system holds the settings, not this app: they survive the app
        // being closed and the phone restarting. So whether the fortress is
        // standing is read back from the store rather than remembered
        // separately, where the two could disagree.
        let store = ManagedSettingsStore()
        _isStanding = Published(initialValue:
            store.shield.applications != nil
            || store.shield.applicationCategories != nil
            || store.shield.webDomains != nil
            || store.webContent.blockedByFilter != nil
        )
    }

    var isEmpty: Bool {
        selection.applicationTokens.isEmpty
            && selection.categoryTokens.isEmpty
            && selection.webDomainTokens.isEmpty
            && sites.isEmpty
    }

    // Returns the domain as stored, or nil if it could not be a site.
    @discardableResult
    func addSite(_ raw: String) -> String? {
        let domain = SharedRules.shared.normalizeDomain(raw)
        guard !domain.isEmpty else { return nil }
        if !sites.contains(domain) {
            sites.append(domain)
        }
        return domain
    }

    // Built up and assigned once, so a whole category is one save and one
    // apply rather than one per site.
    func addSites(_ list: [String]) {
        var next = sites
        for raw in list {
            let domain = SharedRules.shared.normalizeDomain(raw)
            if !domain.isEmpty && !next.contains(domain) {
                next.append(domain)
            }
        }
        if next != sites {
            sites = next
        }
    }

    func removeSite(_ domain: String) {
        sites.removeAll { $0 == domain }
    }

    func raise() {
        apply()
        isStanding = true
    }

    func standDown() {
        store.clearAllSettings()
        isStanding = false
    }

    private func changed() {
        save()
        if isStanding {
            apply()
        }
    }

    private func save() {
        if let data = try? JSONEncoder().encode(selection) {
            defaults.set(data, forKey: Key.selection)
        }
        defaults.set(sites, forKey: Key.sites)
    }

    // Empty sets are written as nil rather than as empty: nil is "no rule",
    // and it keeps isStanding's read-back honest.
    private func apply() {
        let apps = selection.applicationTokens
        let categories = selection.categoryTokens
        let domains = selection.webDomainTokens

        store.shield.applications = apps.isEmpty ? nil : apps
        store.shield.applicationCategories = categories.isEmpty ? nil : .specific(categories)
        store.shield.webDomains = domains.isEmpty ? nil : domains
        // A category picked in the picker covers its websites as well as its
        // apps, the way a category in the extension covers every site in it.
        store.shield.webDomainCategories = categories.isEmpty ? nil : .specific(categories)
        store.webContent.blockedByFilter = sites.isEmpty
            ? nil
            : .specific(Set(sites.map { WebDomain(domain: $0) }))
    }
}
