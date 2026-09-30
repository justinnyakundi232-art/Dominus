import Foundation
import ManagedSettings

// One thing the fortress can hold and an unlock can open: something picked in
// Apple's picker (a token Dominus can show but never read), or a site typed by
// name.
//
// Compiled into the app and every extension, because a request made at the
// block screen, an unlock granted in the app and a re-block when the time runs
// out all have to name the same thing the same way.
enum LockTarget: Codable, Hashable {
    case application(ApplicationToken)
    case webDomain(WebDomainToken)
    case category(ActivityCategoryToken)
    case site(String)

    // How long an unlock opens it for — the same as the halves that already
    // exist: an app is a program, 15 minutes as in the desktop app's
    // gate.js; a site is an hour, as in the extension's Blocked.js.
    var window: TimeInterval {
        switch self {
        case .application, .category: return 15 * 60
        case .webDomain, .site: return 60 * 60
        }
    }

    // A stable name for counting unlocks of the same thing on the same day,
    // which is what escalation counts. A token's encoded form is stable on
    // this phone, and a phone is the only place a token means anything.
    var key: String {
        switch self {
        case .application(let token): return "app:" + Self.encoded(token)
        case .webDomain(let token): return "web:" + Self.encoded(token)
        case .category(let token): return "category:" + Self.encoded(token)
        case .site(let domain): return "site:" + domain
        }
    }

    private static func encoded<T: Encodable>(_ value: T) -> String {
        (try? JSONEncoder().encode(value))?.base64EncodedString() ?? ""
    }
}
