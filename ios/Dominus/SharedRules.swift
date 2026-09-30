import Foundation
import JavaScriptCore

// The extension's own Categories.js, run on the phone through JavaScriptCore.
//
// The file is bundled from the repository root as it is, not copied or
// translated. A second copy of a rule is a rule that will eventually differ —
// the whole reason the desktop app runs the extension's Sync.js rather than a
// Rust one. This is the first proof that the same holds on iOS; Sync.js and
// Stats.js follow the same path when there is something for them to do.
//
// Categories.js is a classic script that declares everything at the top level
// and touches chrome.* only inside functions, so evaluating it has no side
// effects and needs no stand-in for the extension APIs.
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
            self?.failure = exception?.toString() ?? "Categories.js threw while loading."
        }
        guard
            let url = Bundle.main.url(forResource: "Categories", withExtension: "js"),
            let source = try? String(contentsOf: url, encoding: .utf8)
        else {
            failure = "Categories.js is missing from the app bundle."
            return
        }
        context.evaluateScript(source, withSourceURL: url)
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
