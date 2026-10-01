import SwiftUI
import FamilyControls

// The Keep: where you stand. The same dashboard the extension and the desktop
// app open on, in the same words, from the same figures — Stats.js's own.
//
// On the phone it is also where anything that needs you shows first. A
// request from the block screen and a timer that has just started are at the
// top, glowing, because they are what the app was opened for.
struct KeepView: View {
    @EnvironmentObject private var fortress: Fortress
    @EnvironmentObject private var record: Record
    @EnvironmentObject private var session: Session
    @ObservedObject private var center = AuthorizationCenter.shared

    var body: some View {
        Page("The Keep") {
            if let request = session.pending {
                unlockRequested(request)
            }
            if !fortress.openUnlocks.isEmpty {
                openForNow
            }
            if center.authorizationStatus != .approved {
                notSetUp
            }
            today
            streaks
            victoryRate
            whatStands
            if let failure = record.failure {
                Text("The record couldn't be read: \(failure)")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    // MARK: - What needs you

    private func unlockRequested(_ request: Gate.UnlockRequest) -> some View {
        Panel("Unlock requested", glowing: true) {
            TargetLabel(target: request.target)
                .font(.title3)
                .foregroundStyle(Theme.parchment)
            (Text("Asked ") + Text(request.at, style: .relative) + Text(" ago from the block screen."))
                .font(.footnote)
                .foregroundStyle(Theme.goldDim)
            if fortress.isOpen(request.target) {
                Text("Already open.")
                    .foregroundStyle(Theme.parchment)
                GoldButton("Dismiss", secondary: true) { session.dismissRequest() }
            } else {
                GoldButton("Stay focused") {
                    record.stand()
                    session.dismissRequest()
                }
                GoldButton("Begin unlock", secondary: true) {
                    session.begin(request.target, fromRequest: true)
                }
            }
        }
    }

    private var openForNow: some View {
        Panel("Open for now", glowing: true) {
            ForEach(fortress.openUnlocks) { unlock in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        TargetLabel(target: unlock.target)
                            .foregroundStyle(Theme.parchment)
                        (Text("Blocked again in ") + Text(unlock.until, style: .relative))
                            .font(.footnote)
                            .foregroundStyle(Theme.goldDim)
                    }
                    Spacer()
                    // Closing early is strengthening, so it is free.
                    Button("Close now") { fortress.close(unlock) }
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.gold)
                }
            }
        }
    }

    private var notSetUp: some View {
        Panel("Not set up yet") {
            Text("Dominus blocks apps and sites through Screen Time, and hasn't been allowed to yet.")
                .foregroundStyle(Theme.parchment)
            GoldButton("Set it up in The Fortress") { session.tab = .fortress }
        }
    }

    // MARK: - Where you stand

    // The extension's Keep, line for line.
    private var today: some View {
        Panel("Today") {
            switch record.todayState {
            case .slipped:
                Text("A gate gave way today.")
                    .font(.system(.title3, design: .serif))
                    .foregroundStyle(Theme.parchment)
                if let time = record.today?.firstSlip {
                    Text("First unlock at \(time).")
                        .font(.footnote)
                        .foregroundStyle(Theme.goldDim)
                }
            case .held:
                let stands = record.today?.stands ?? 0
                Text("You have held the line \(stands) \(stands == 1 ? "time" : "times") today.")
                    .font(.system(.title3, design: .serif))
                    .foregroundStyle(Theme.parchment)
                Text("Every one of those was a choice.")
                    .font(.footnote)
                    .foregroundStyle(Theme.goldDim)
            default:
                Text("Nothing has tested you today.")
                    .font(.system(.title3, design: .serif))
                    .foregroundStyle(Theme.parchment)
                Text("An untested day keeps your streak — it just wasn't a fight.")
                    .font(.footnote)
                    .foregroundStyle(Theme.goldDim)
            }
        }
    }

    // Two streaks that measure different things on purpose: days kept clean,
    // and stands made in a row with no unlock between them.
    private var streaks: some View {
        HStack(alignment: .top, spacing: 12) {
            figure(
                "Discipline",
                value: record.standing?.currentStreak,
                unit: ("day", "days"),
                longest: record.standing?.longestStreak
            )
            figure(
                "Resistance",
                value: record.standing?.currentResistance,
                unit: ("stand", "stands"),
                longest: record.standing?.longestResistance
            )
        }
    }

    private func figure(_ title: String, value: Int?, unit: (String, String), longest: Int?) -> some View {
        Panel(title) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(value.map { String($0) } ?? "–")
                    .font(.system(size: 44, weight: .bold, design: .serif))
                    .foregroundStyle(Theme.gold)
                Text(value == 1 ? unit.0 : unit.1)
                    .font(.footnote)
                    .foregroundStyle(Theme.goldDim)
            }
            if let longest, longest > 0 {
                Text("Longest \(longest) \(longest == 1 ? unit.0 : unit.1)")
                    .font(.footnote)
                    .foregroundStyle(Theme.goldDim)
            }
        }
    }

    private var victoryRate: some View {
        Panel("Victory rate") {
            let standing = record.standing
            let total = (standing?.stayFocusedCount ?? 0) + (standing?.unlockCount ?? 0)
            Text(standing?.ratio.map { "\(Int(($0 * 100).rounded()))%" } ?? "–")
                .font(.system(size: 44, weight: .bold, design: .serif))
                .foregroundStyle(Theme.gold)
            Text(total == 0
                 ? "Nothing has tested you yet"
                 : "From \(total) \(total == 1 ? "moment" : "moments")")
                .font(.footnote)
                .foregroundStyle(Theme.goldDim)
        }
    }

    private var whatStands: some View {
        Panel("What stands") {
            let selection = fortress.selection
            let apps = selection.applicationTokens.count
            let categories = selection.categoryTokens.count
            let sites = selection.webDomainTokens.count + fortress.sites.count

            if fortress.isEmpty {
                Text("Nothing is blocked yet. The fortress has no walls.")
                    .foregroundStyle(Theme.parchment)
            } else {
                Text(fortress.isStanding ? "The fortress is standing." : "The fortress is down. Nothing is blocked.")
                    .foregroundStyle(Theme.parchment)
                Text("\(apps) \(apps == 1 ? "app" : "apps"), \(categories) \(categories == 1 ? "category" : "categories") and \(sites) \(sites == 1 ? "site" : "sites").")
                    .font(.footnote)
                    .foregroundStyle(Theme.goldDim)
            }
        }
    }
}
