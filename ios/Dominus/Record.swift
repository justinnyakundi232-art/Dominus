import Foundation

// The fortress's record — streaks, the victory rate, today — as Stats.js
// keeps it.
//
// Nothing here is worked out in Swift. Stands and slips are handed to
// Stats.js's own recordStayFocused() and recordUnlock(), and what the app
// shows is read back from its getStats() and getDayHistory(). The numbers on
// the phone are the numbers Chrome would show for the same history.
@MainActor
final class Record: ObservableObject {
    // What Stats.js's getStats() returns.
    struct Standing: Decodable {
        let currentStreak: Int
        let longestStreak: Int
        let currentResistance: Int
        let longestResistance: Int
        let ratio: Double?
        let stayFocusedCount: Int
        let unlockCount: Int
    }

    // One day of its day log.
    struct Day: Decodable {
        let stands: Int
        let unlocks: Int
        let firstSlip: String?
    }

    // Its day states, by its own names.
    enum DayState: String, Decodable {
        case before, untested, held, slipped, inferred
    }

    private struct View: Decodable {
        let standing: Standing
        let todayState: DayState
        let today: Day?
    }

    @Published private(set) var standing: Standing?
    @Published private(set) var todayState: DayState = .untested
    @Published private(set) var today: Day?
    @Published private(set) var campaign: Campaign?
    @Published private(set) var failure: String?

    // The Campaign's history, as Bridge.js hands it over: every day already
    // named, described and levelled by TrackProgress.js, and the grid's shape
    // — how far the first week is pushed down, which columns carry a month —
    // worked out the way that file works it out.
    struct Campaign: Decodable {
        struct Day: Decodable, Identifiable {
            let date: String
            let state: DayState
            let level: Int
            let label: String
            let stateLabel: String
            let description: String
            let today: Bool

            var id: String { date }
        }

        struct Summary: Decodable {
            let recorded: Int
            let span: String
            let held: Int
            let slipped: Int
            let untested: Int
        }

        let weeks: Int
        let blanks: Int
        let months: [String]
        let weekdays: [String]
        let summary: Summary
        let days: [Day]
    }

    private let rules = SharedRules.shared
    private var defaults: UserDefaults { Gate.defaults ?? .standard }

    private enum Key {
        static let carriedOver = "record.carriedOverTestBuilds"
    }

    // Called whenever the app comes to the front: first anything that
    // happened while it was away, then the figures.
    func refresh() {
        carryOverTestBuilds()
        recordStandsFromBlockScreen()
        read()
    }

    // A stand made inside the app, recorded as it happens.
    func stand() {
        note(rules.record([SharedRules.Event(kind: .stand)]))
        read()
    }

    // An unlock, recorded as it happens. `domain` names the site where there
    // is a name to give.
    func slip(domain: String?) {
        note(rules.record([SharedRules.Event(kind: .slip, domain: domain)]))
        read()
    }

    // The block screen's stands, each at the time it was made. Only taken off
    // the list once Stats.js has them.
    private func recordStandsFromBlockScreen() {
        let stands = Gate.standTimes.sorted()
        guard !stands.isEmpty else { return }

        let problem = rules.record(stands.map {
            SharedRules.Event(kind: .stand, at: Date(timeIntervalSince1970: $0))
        })
        note(problem)
        if problem == nil {
            Gate.removeStands(stands)
        }
    }

    // Builds 3 and 4 counted stands and slips before Stats.js was running.
    // They are handed over once, in the order they happened, so the record
    // starts from what was actually done rather than from nothing.
    private func carryOverTestBuilds() {
        guard !defaults.bool(forKey: Key.carriedOver) else { return }

        let stands = Gate.standTimes
        let slips = FortressState.load()?.slips ?? []
        var events = stands.map {
            SharedRules.Event(kind: .stand, at: Date(timeIntervalSince1970: $0))
        }
        events += slips.map { slip in
            SharedRules.Event(
                kind: .slip,
                at: slip.at,
                domain: slip.key.hasPrefix("site:") ? String(slip.key.dropFirst("site:".count)) : nil
            )
        }
        events.sort { ($0.at ?? .distantPast) < ($1.at ?? .distantPast) }

        let problem = rules.record(events)
        note(problem)
        if problem == nil {
            Gate.removeStands(stands)
            defaults.set(true, forKey: Key.carriedOver)
        }
    }

    private func read() {
        switch rules.standing() {
        case .success(let data):
            do {
                let view = try JSONDecoder().decode(View.self, from: data)
                standing = view.standing
                todayState = view.todayState
                today = view.today
            } catch {
                failure = "Dominus couldn't read its record: \(error.localizedDescription)"
            }
        case .failure(let problem):
            failure = problem.message
        }

        // Read alongside, not on demand: it is the same record, and a stand
        // made a moment ago should be on the grid when the tab is opened.
        if case .success(let data) = rules.campaign() {
            campaign = try? JSONDecoder().decode(Campaign.self, from: data)
        }
    }

    private func note(_ problem: String?) {
        if let problem {
            failure = problem
        }
    }
}
