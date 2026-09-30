import Foundation
import JavaScriptCore

// The extension's own Categories.js and Tasks.js, run on the phone through
// JavaScriptCore.
//
// The files are bundled from the repository root as they are, not copied or
// translated. A second copy of a rule is a rule that will eventually differ —
// the whole reason the desktop app runs the extension's Sync.js rather than a
// Rust one. Sync.js and Stats.js follow the same path when there is something
// for them to do.
//
// Both are classic scripts that declare everything at the top level and touch
// chrome.* and the DOM only inside functions, so evaluating them has no side
// effects. The one browser API they reach for is crypto.getRandomValues, in
// Tasks.js's randomInt(); JavaScriptCore has no crypto, so it is supplied
// below from the system's secure generator. That stands in for the platform,
// not for a rule.
final class SharedRules {
    static let shared = SharedRules()

    struct Category: Identifiable {
        let name: String
        let sites: [String]
        var id: String { name }
    }

    private let context: JSContext
    private(set) var failure: String?

    var isLoaded: Bool { failure == nil }

    private init() {
        context = JSContext()
        context.exceptionHandler = { [weak self] _, exception in
            self?.failure = exception?.toString() ?? "A shared script threw while loading."
        }

        let random: @convention(block) () -> UInt32 = { UInt32.random(in: .min ... .max) }
        context.setObject(random, forKeyedSubscript: "__dominusRandomUInt32" as NSString)
        context.evaluateScript("""
            var crypto = {
                getRandomValues: function (array) {
                    for (var i = 0; i < array.length; i++) array[i] = __dominusRandomUInt32();
                    return array;
                }
            };
            """)

        for name in ["Categories", "Tasks"] {
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

    // "https://www.youtube.com/feed" -> "youtube.com", and "" for anything that
    // cannot be a hostname — exactly what the extension stores.
    func normalizeDomain(_ raw: String) -> String {
        guard
            let function = context.objectForKeyedSubscript("normalizeDomain"),
            function.isObject,
            let result = function.call(withArguments: [raw]),
            result.isString
        else { return "" }
        return result.toString()
    }

    // A fresh line of random words, as the blocked page shows for the Random
    // Passage task. Empty only if Tasks.js failed to load, which the footer
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

    // "3 minutes", "2 min 30 sec".
    func formatHuman(_ seconds: Int) -> String {
        call("formatHuman", [seconds])?.toString() ?? "\(seconds) sec"
    }

    private func call(_ name: String, _ arguments: [Any]) -> JSValue? {
        guard let function = context.objectForKeyedSubscript(name), function.isObject else {
            return nil
        }
        return function.call(withArguments: arguments)
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
}
