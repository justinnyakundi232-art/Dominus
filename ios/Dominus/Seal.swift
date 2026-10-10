import Foundation
import UserNotifications

// The seal: a password on anything that weakens the fortress.
//
// All of it is Seal.js's. The password is hashed, checked, changed and broken
// by the extension's functions, the count of wrong attempts and the wait they
// earn are its, and so is the hour a forgotten seal takes to lift. This only
// carries the questions across and holds the answers for the screens.
//
// It is not a lock, here any more than in Chrome. Deleting Dominus lifts
// everything and always will. What the seal is for is the eleven-o'clock
// impulse, and someone else idly poking at the phone.
@MainActor
final class Seal: ObservableObject {
    struct Status: Decodable, Equatable {
        let enabled: Bool
        let hint: String
        let recovering: Bool
        let recoveryRemainingMs: Double
        // "43 min", deliberately coarse: a countdown to the second would
        // invite watching it.
        let recoveryRemaining: String
        let waitSeconds: Int
        let minLength: Int
        let maxHintLength: Int
    }

    // What Seal.js answers an attempt with. The error is its own wording.
    struct Outcome: Decodable {
        let ok: Bool
        var error: String?
    }

    @Published private(set) var status: Status?
    @Published private(set) var failure: String?

    private let rules = SharedRules.shared
    private static let recoveryNotification = "dominus.sealrecovery"

    var isSealed: Bool { status?.enabled == true }
    var isRecovering: Bool { status?.recovering == true }

    // Called when the app comes to the front. Reading the seal is also what
    // lifts one whose recovery has run out, so this is where that happens.
    func refresh() {
        take(rules.seal())
    }

    // While a recovery is running and the app is open, so the hour ends in
    // front of whoever is waiting for it.
    func refreshIfRecovering() {
        if isRecovering {
            refresh()
        }
    }

    func check(_ password: String) -> Outcome {
        let answer = outcome(of: rules.checkSeal(password))
        refresh()
        return answer
    }

    func set(_ password: String, hint: String) -> Outcome {
        let answer = outcome(of: rules.setSeal(password, hint: hint))
        refresh()
        return answer
    }

    func change(current: String, next: String, hint: String) -> Outcome {
        let answer = outcome(of: rules.changeSeal(current: current, next: next, hint: hint))
        refresh()
        return answer
    }

    func clear(_ password: String) -> Outcome {
        let answer = outcome(of: rules.clearSeal(password))
        refresh()
        return answer
    }

    // Starts the hour. Asking twice does not start it again.
    func requestRecovery() {
        take(rules.requestSealRecovery())
        guard let status, status.recovering, status.recoveryRemainingMs > 0 else { return }

        let content = UNMutableNotificationContent()
        content.title = "Your seal has lifted"
        content.body = "The fortress is still standing. Set a new seal when you're ready."
        content.sound = .default
        let trigger = UNTimeIntervalNotificationTrigger(
            timeInterval: max(1, status.recoveryRemainingMs / 1000),
            repeats: false
        )
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: Seal.recoveryNotification, content: content, trigger: trigger)
        )
    }

    // Free and instant, as in Chrome: a recovery thought better of should
    // cost nothing to call off, or nobody will risk starting one.
    func cancelRecovery() {
        take(rules.cancelSealRecovery())
    }

    private func take(_ result: Result<Data, SharedRules.Problem>) {
        switch result {
        case .success(let data):
            if let status = try? JSONDecoder().decode(Status.self, from: data) {
                self.status = status
                failure = nil
                if !status.recovering {
                    UNUserNotificationCenter.current()
                        .removePendingNotificationRequests(withIdentifiers: [Seal.recoveryNotification])
                }
            } else {
                failure = "Dominus couldn't read the seal."
            }
        case .failure(let problem):
            failure = problem.message
        }
    }

    private func outcome(of result: Result<Data, SharedRules.Problem>) -> Outcome {
        switch result {
        case .success(let data):
            return (try? JSONDecoder().decode(Outcome.self, from: data))
                ?? Outcome(ok: false, error: "Dominus couldn't read the answer.")
        case .failure(let problem):
            return Outcome(ok: false, error: problem.message)
        }
    }
}
