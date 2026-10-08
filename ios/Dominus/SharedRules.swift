import Foundation
import JavaScriptCore

// The extension's own shared layer, run on the phone through JavaScriptCore:
// Tasks.js, Categories.js, Applications.js, Stats.js, Seal.js and Sync.js —
// the set its service worker loads, in the same order.
//
// The files are bundled from the repository root as they are, not copied or
// translated. A second copy of a rule is a rule that will eventually differ —
// the whole reason the desktop app runs the extension's Sync.js rather than a
// Rust one. So what a category is, what counts as taking a defence down, how
// long a cooldown runs and how a streak is counted are all decided by the
// code that decides them in Chrome.
//
// They are classic scripts that declare everything at the top level and touch
// chrome.* and the DOM only inside functions, so evaluating them has no side
// effects. What they need from a browser — crypto, chrome.storage.local — is
// supplied by ../Bridge.js, loaded first, which in turn rests on the native
// functions set up below. All of that stands in for the platform, not for a
// rule. Tests/bridge.test.js loads the same files in the same order.
final class SharedRules {
    static let shared = SharedRules()

    struct Category: Identifiable {
        let name: String
        let sites: [String]
        var id: String { name }
    }

    // One stand or slip to hand to Stats.js. With no `at` it is recorded as
    // now; with one, at the moment it actually happened.
    struct Event {
        enum Kind: String {
            case stand, slip
        }

        let kind: Kind
        var at: Date?
        var domain: String?
    }

    private let context: JSContext
    private(set) var failure: String?

    var isLoaded: Bool { failure == nil }

    // Where Stats.js's chrome.storage.local lands: the App Group, one JSON
    // string per key, under a prefix that keeps the extension's keys apart
    // from the app's own.
    private static var storage: UserDefaults { Gate.defaults ?? .standard }
    private static let storagePrefix = "extension."

    private init() {
        context = JSContext()
        context.exceptionHandler = { [weak self] _, exception in
            self?.failure = exception?.toString() ?? "A shared script threw."
        }

        let random: @convention(block) () -> UInt32 = { UInt32.random(in: .min ... .max) }
        // A missing key is JavaScript's null, which Bridge.js reads as "not
        // stored yet".
        let read: @convention(block) (String) -> Any = { key in
            if let json = SharedRules.storage.string(forKey: SharedRules.storagePrefix + key) {
                return json
            }
            return NSNull()
        }
        let write: @convention(block) (String, String) -> Void = { key, json in
            SharedRules.storage.set(json, forKey: SharedRules.storagePrefix + key)
        }
        let uuid: @convention(block) () -> String = { UUID().uuidString.lowercased() }
        context.setObject(random, forKeyedSubscript: "__dominusRandomUInt32" as NSString)
        context.setObject(uuid, forKeyedSubscript: "__dominusUUID" as NSString)
        context.setObject(read, forKeyedSubscript: "__dominusStorageRead" as NSString)
        context.setObject(write, forKeyedSubscript: "__dominusStorageWrite" as NSString)

        for name in ["Bridge", "Tasks", "Categories", "Applications", "Stats", "Seal", "Sync", "TrackProgress"] {
            guard
                let url = Bundle.main.url(forResource: name, withExtension: "js"),
                let source = try? String(contentsOf: url, encoding: .utf8)
            else {
                failure = "\(name).js is missing from the app bundle."
                return
            }
            context.evaluateScript(source, withSourceURL: url)
        }
    }

    // MARK: - Categories.js

    // "https://www.youtube.com/feed" -> "youtube.com", and "" for anything that
    // cannot be a hostname — exactly what the extension stores.
    func normalizeDomain(_ raw: String) -> String {
        guard let result = call("normalizeDomain", [raw]), result.isString else { return "" }
        return result.toString()
    }

    // DEFAULT_CATEGORIES is a top-level const, which JavaScriptCore keeps in
    // the script scope rather than on the global object, so it is read by
    // evaluating its name rather than by subscripting.
    var defaultCategories: [Category] {
        guard let list = context.evaluateScript("DEFAULT_CATEGORIES")?.toArray() as? [[String: Any]] else {
            return []
        }
        return list.compactMap { entry in
            guard let name = entry["name"] as? String, let sites = entry["sites"] as? [String] else {
                return nil
            }
            return Category(name: name, sites: sites)
        }
    }

    // MARK: - The fortress (Seal.js, by way of Bridge.js)

    // Fortresses cross as JSON text in both directions; see Bridge.js for why.

    // The fortress as stored, with the block list derived from it.
    func fortress() -> Result<Data, Problem> {
        json("__dominusFortress", [])
    }

    // What an edit would take down, as describeWeakening() words it.
    func review(_ edit: Data) -> Result<Data, Problem> {
        json("__dominusReview", [String(decoding: edit, as: UTF8.self)])
    }

    // Stamps and writes an edit.
    func commit(_ edit: Data) -> Result<Data, Problem> {
        json("__dominusCommit", [String(decoding: edit, as: UTF8.self)])
    }

    // The task and cooldown that govern unlocking a site, or, with no name to
    // look up, the fortress's own.
    func standards(for domain: String?) -> Result<Data, Problem> {
        let argument: Any = domain ?? ""
        return json("__dominusStandards", [argument])
    }

    // Sites typed into the test builds lived in the app's own list. Put where
    // the extension's first-run migration looks for a block list, they become
    // sites blocked by hand — by loadCategories() itself, not by a copy of it.
    // Only ever before that first read: afterwards the stored list is derived
    // and writing it would be overwritten or, worse, believed.
    func carryOverSites(_ sites: [String]) {
        let defaults = SharedRules.storage
        guard
            !sites.isEmpty,
            defaults.string(forKey: SharedRules.storagePrefix + "categoryDefs") == nil,
            let data = try? JSONEncoder().encode(sites)
        else { return }
        defaults.set(String(decoding: data, as: UTF8.self), forKey: SharedRules.storagePrefix + "blockedSites")
    }

    // MARK: - Tasks.js

    // A fresh line of random words, as the blocked page shows for the Random
    // Passage task. Empty only if Tasks.js failed to load, which the app
    // reports.
    func generatePassage() -> String {
        call("generatePassage", [])?.toString() ?? ""
    }

    // How long the cooldown runs, given how many times this same thing was
    // unlocked earlier today — the extension's own escalation and cap.
    func effectiveCooldownSeconds(_ settings: [String: Any], priorUnlocks: Int) -> Int {
        guard let value = call("effectiveCooldownSeconds", [settings, priorUnlocks]), value.isNumber else {
            return 60
        }
        return Int(value.toInt32())
    }

    // "M:SS", as the blocked page's countdown reads.
    func formatClock(_ seconds: Int) -> String {
        call("formatClock", [seconds])?.toString() ?? "\(seconds)"
    }

    // A code for the Guarded Code task: eight characters with nothing that
    // can be misread on paper.
    func generateGuardCode() -> String {
        call("generateGuardCode", [])?.toString() ?? ""
    }

    // "3 minutes", "2 min 30 sec".
    func formatHuman(_ seconds: Int) -> String {
        call("formatHuman", [seconds])?.toString() ?? "\(seconds) sec"
    }

    // MARK: - Stats.js

    // Hands stands and slips to recordStayFocused() and recordUnlock(), oldest
    // first, each at its own moment. Returns what went wrong, or nil.
    func record(_ events: [Event]) -> String? {
        guard !events.isEmpty else { return nil }

        let payload: [[String: Any]] = events.map { event in
            var entry: [String: Any] = ["type": event.kind.rawValue]
            if let at = event.at {
                entry["at"] = (at.timeIntervalSince1970 * 1000).rounded()
            }
            if let domain = event.domain {
                entry["domain"] = domain
            }
            return entry
        }

        switch settle(call("__dominusRecord", [payload])) {
        case .success: return nil
        case .failure(let problem): return problem.message
        }
    }

    // Stats.js's own view of where the fortress stands, and today's day, as
    // JSON for whoever asked to decode.
    func standing() -> Result<Data, Problem> {
        json("__dominusStanding", [])
    }

    // The Campaign: the same figures, and twenty-six weeks of days, each one
    // already labelled, described and shaded by TrackProgress.js.
    func campaign() -> Result<Data, Problem> {
        json("__dominusCampaign", [])
    }

    // MARK: - Calling in

    struct Problem: Error {
        let message: String
    }

    // Calls a bridge function that resolves to JSON text, and hands the text
    // back for whoever asked to decode.
    private func json(_ name: String, _ arguments: [Any]) -> Result<Data, Problem> {
        settle(call(name, arguments)).flatMap { value -> Result<Data, Problem> in
            guard value.isString, let data = value.toString().data(using: .utf8) else {
                return .failure(Problem(message: "The shared scripts returned nothing to read."))
            }
            return .success(data)
        }
    }

    private func call(_ name: String, _ arguments: [Any]) -> JSValue? {
        guard let function = context.objectForKeyedSubscript(name), function.isObject else {
            return nil
        }
        return function.call(withArguments: arguments)
    }

    // Swift cannot await a JavaScript promise. Bridge.js puts the outcome in a
    // box instead, and JavaScriptCore runs every queued step of a chain before
    // a call into it returns — the storage callbacks are synchronous, so
    // nothing in these chains waits on anything else. If the box is somehow
    // still empty, one more trip in and out gives it a second chance before
    // this reports a failure rather than a wrong number.
    private func settle(_ promise: JSValue?) -> Result<JSValue, Problem> {
        guard let promise, let box = call("__dominusSettle", [promise]) else {
            return .failure(Problem(message: failure ?? "The shared scripts did not load."))
        }
        if box.forProperty("done")?.toBool() != true {
            context.evaluateScript("void 0")
        }
        guard box.forProperty("done")?.toBool() == true else {
            return .failure(Problem(message: "The shared scripts did not finish."))
        }
        if let error = box.forProperty("error"), error.isString {
            return .failure(Problem(message: error.toString()))
        }
        guard let value = box.forProperty("value") else {
            return .failure(Problem(message: "The shared scripts returned nothing."))
        }
        return .success(value)
    }
}
