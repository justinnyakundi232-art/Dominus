import ManagedSettings
import UserNotifications

// The block screen's two buttons.
//
// Stay focused is a stand, and closes what was blocked. Unlock leaves a
// request for the app and posts a notification, because an extension has no
// way to open its app, and the cooldown and the task can only run there.
// Whether that notification is a good enough way in is what build 3 exists to
// find out.
final class ShieldActionExtension: ShieldActionDelegate {
    override func handle(action: ShieldAction, for application: ApplicationToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
        respond(to: action, target: .application(application), completionHandler: completionHandler)
    }

    override func handle(action: ShieldAction, for webDomain: WebDomainToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
        respond(to: action, target: .webDomain(webDomain), completionHandler: completionHandler)
    }

    override func handle(action: ShieldAction, for category: ActivityCategoryToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
        respond(to: action, target: .category(category), completionHandler: completionHandler)
    }

    private func respond(
        to action: ShieldAction,
        target: LockTarget,
        completionHandler: @escaping (ShieldActionResponse) -> Void
    ) {
        switch action {
        case .primaryButtonPressed:
            Gate.recordStand()
            completionHandler(.close)
        case .secondaryButtonPressed:
            Gate.requestUnlock(target)
            // Closed rather than deferred: the notification lands on the home
            // screen, where it is certain to be seen, instead of over a shield
            // that is still standing.
            notify { completionHandler(.close) }
        default:
            // Newer SDKs name more actions than these two buttons. None of
            // them is a stand or an unlock request, so they only close.
            completionHandler(.close)
        }
    }

    // The response is held until the notification has been handed over,
    // since iOS may end the extension as soon as it answers.
    private func notify(then done: @escaping () -> Void) {
        let content = UNMutableNotificationContent()
        content.title = "Unlock requested"
        content.body = "Open Dominus to begin. The cooldown and the task still apply."
        content.sound = .default

        let request = UNNotificationRequest(identifier: "dominus.unlock", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            Gate.notificationFailure = error?.localizedDescription
            done()
        }
    }
}
