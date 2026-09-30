import Foundation
import ManagedSettings

// What the block screen and the app say to each other.
//
// The block screen's buttons are handled by DominusShieldAction, a separate
// program iOS runs on its own. It cannot open the app, and the app is not
// running to be told anything, so the two leave notes for each other in the
// App Group — a storage area both are entitled to read and write.
//
// Compiled into the app and into DominusShieldAction, so both read and write
// the same keys in the same shapes.
enum Gate {
    static let appGroup = "group.com.aj7developments.dominus"

    // Nil when this target isn't entitled to the App Group, or the group was
    // never registered. UserDefaults(suiteName:) would quietly hand back a
    // store nobody else can see, so the container is checked first and the
    // app says so rather than losing every note in silence.
    static var defaults: UserDefaults? {
        guard FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) != nil else {
            return nil
        }
        return UserDefaults(suiteName: appGroup)
    }

    private enum Key {
        static let unlock = "gate.unlockRequest"
        static let stands = "gate.stands"
        static let notificationFailure = "gate.notificationFailure"
    }

    struct UnlockRequest: Codable {
        enum Target: Codable {
            case application(ApplicationToken)
            case webDomain(WebDomainToken)
            case category(ActivityCategoryToken)
        }

        let target: Target
        let at: Date
    }

    // One request at a time: a newer one replaces an older, since only the
    // latest thing someone asked for is the thing they are waiting on.
    static func requestUnlock(_ target: UnlockRequest.Target) {
        let request = UnlockRequest(target: target, at: Date())
        if let data = try? JSONEncoder().encode(request) {
            defaults?.set(data, forKey: Key.unlock)
        }
    }

    static var pendingUnlock: UnlockRequest? {
        defaults?.data(forKey: Key.unlock)
            .flatMap { try? JSONDecoder().decode(UnlockRequest.self, from: $0) }
    }

    static func clearUnlock() {
        defaults?.removeObject(forKey: Key.unlock)
    }

    // Choosing Stay focused at the block screen is a stand, exactly as walking
    // away from the blocked page is in Chrome. Kept as times rather than a
    // count, because the streak and the day log are derived from dates.
    static func recordStand() {
        var times = stands.map(\.timeIntervalSince1970)
        times.append(Date().timeIntervalSince1970)
        defaults?.set(Array(times.suffix(500)), forKey: Key.stands)
    }

    static var stands: [Date] {
        (defaults?.array(forKey: Key.stands) as? [Double] ?? [])
            .map(Date.init(timeIntervalSince1970:))
    }

    // The block screen has no way to show an error, so a notification that
    // failed to post is written here for the app to report.
    static var notificationFailure: String? {
        get { defaults?.string(forKey: Key.notificationFailure) }
        set { defaults?.set(newValue, forKey: Key.notificationFailure) }
    }
}
