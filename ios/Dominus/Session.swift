import SwiftUI
import UserNotifications

// What the app is in the middle of: which tab is showing, whether the block
// screen has asked for an unlock, and whether one is being run.
//
// Kept above the tabs because none of it belongs to one of them. A request
// arrives whatever tab was last open, and an unlock ends with a timer that
// has to be seen wherever it was started from.
@MainActor
final class Session: ObservableObject {
    enum Tab: Hashable {
        case keep, fortress, campaign, seal
    }

    // The unlock being run, if any. `fromRequest` clears the block screen's
    // request once it has been answered either way.
    struct Unlocking: Identifiable {
        let id = UUID()
        let target: LockTarget
        let fromRequest: Bool
    }

    @Published var tab: Tab = .keep
    @Published var unlocking: Unlocking?
    @Published private(set) var pending: Gate.UnlockRequest?
    @Published private(set) var notifications: UNAuthorizationStatus = .notDetermined

    // A request from the block screen is the reason the app was opened, so it
    // is brought to The Keep, where it is the first thing shown.
    func refresh() {
        pending = Gate.pendingUnlock
        if pending != nil && unlocking == nil {
            tab = .keep
        }
        Task {
            notifications = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        }
    }

    func begin(_ target: LockTarget, fromRequest: Bool) {
        unlocking = Unlocking(target: target, fromRequest: fromRequest)
    }

    // However it ended, the unlock is over: the request it answered is
    // cleared, and The Keep is where the result shows — a new timer, or a
    // stand.
    func finish(_ unlocking: Unlocking) {
        if unlocking.fromRequest {
            Gate.clearUnlock()
        }
        self.unlocking = nil
        pending = Gate.pendingUnlock
        tab = .keep
    }

    func dismissRequest() {
        Gate.clearUnlock()
        pending = nil
    }

    func allowNotifications() {
        Task {
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
            notifications = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        }
    }
}
