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
    @EnvironmentObject private var seal: Seal
    @ObservedObject private var center = AuthorizationCenter.shared

    var body: some View {
        Page("The Keep", emblem: "Watchtower") {
            // Whatever needs you, first and glowing.
            Group {
                if let request = session.pending {
                    unlockRequested(request)
                }
                if !fortress.openUnlocks.isEmpty {
                    openForNow
                }
                if fortress.standDown != .none {
                    Panel("The fortress is coming down", glowing: true) {
                        StandDownStatus()
                    }
                }
                // A seal lifting in an hour is worth knowing about here most
                // of all: this is where you find out what your defences are
                // still worth.
                if seal.isRecovering {
                    Panel("The seal is lifting", glowing: true) {
                        RecoveryStatus()
                    }
                }
                if center.authorizationStatus != .approved {
                    notSetUp
                }
            }
            today
            streaks
            victoryRate
            whatStands
            theSeal
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
                    .font(.display(20, relativeTo: .title3, bold: false))
                    .foregroundStyle(Theme.parchment)
                if let time = record.today?.firstSlip {
                    Text("First unlock at \(time).")
                        .font(.footnote)
                        .foregroundStyle(Theme.goldDim)
                }
            case .held:
                let stands = record.today?.stands ?? 0
                Text("You have held the line \(stands) \(stands == 1 ? "time" : "times") today.")
                    .font(.display(20, relativeTo: .title3, bold: false))
                    .foregroundStyle(Theme.parchment)
                Text("Every one of those was a choice.")
                    .font(.footnote)
                    .foregroundStyle(Theme.goldDim)
            default:
                Text("Nothing has tested you today.")
                    .font(.display(20, relativeTo: .title3, bold: false))
                    .foregroundStyle(Theme.parchment)
                Text("An untested day keeps your streak — it just wasn't a fight.")
                    .font(.footnote)
                    .foregroundStyle(Theme.goldDim)
            }
        }
    }

    // Two streaks that measure different things on purpose: days kept clean,
    // and stands made in a row with no unlock between them.
    //
    // Each says "streak" in its title, "in a row" beside its number, and
    // explains itself on a tap. A bare "0 stands" above "Longest 4 stands"
    // read as no stands ever made, when it meant none since the last unlock.
    // One above the other rather than side by side, so the words fit.
    private var streaks: some View {
        VStack(spacing: 24) {
            figure(
                "Discipline streak",
                info: "Days in a row with no unlock. A day nothing tested you still counts. An unlock ends the run, and the next clean day starts a new one.",
                value: record.standing?.currentStreak,
                unit: ("day", "days"),
                longest: record.standing?.longestStreak
            )
            figure(
                "Resistance streak",
                info: "Times in a row you chose Stay focused with no unlock in between. An unlock sets it back to zero. It is not your total: every stand you have made counts toward the victory rate below.",
                value: record.standing?.currentResistance,
                unit: ("stand", "stands"),
                longest: record.standing?.longestResistance
            )
        }
    }

    private func figure(_ title: String, info: String, value: Int?, unit: (String, String), longest: Int?) -> some View {
        Panel(title, info: info) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(value.map { String($0) } ?? "–")
                    .font(.display(44))
                    .foregroundStyle(Theme.gold)
                Text("\(value == 1 ? unit.0 : unit.1) in a row")
                    .font(.footnote)
                    .foregroundStyle(Theme.goldDim)
            }
            if let longest, longest > 0 {
                Text("Longest streak: \(longest) \(longest == 1 ? unit.0 : unit.1)")
                    .font(.footnote)
                    .foregroundStyle(Theme.goldDim)
            }
        }
    }

    private var victoryRate: some View {
        Panel(
            "Victory rate",
            info: "Of all the times a block has stopped you, the share where you chose Stay focused rather than unlocking. Every stand and every unlock you have made counts, from the first."
        ) {
            let standing = record.standing
            let stands = standing?.stayFocusedCount ?? 0
            let unlocks = standing?.unlockCount ?? 0
            let total = stands + unlocks
            Text(standing?.ratio.map { "\(Int(($0 * 100).rounded()))%" } ?? "–")
                .font(.display(44))
                .foregroundStyle(Theme.gold)
            Text(total == 0
                 ? "Nothing has tested you yet"
                 : "From \(total) \(total == 1 ? "moment" : "moments"): \(stands) \(stands == 1 ? "stand" : "stands"), \(unlocks) \(unlocks == 1 ? "unlock" : "unlocks")")
                .font(.footnote)
                .foregroundStyle(Theme.goldDim)
        }
    }

    // The extension's Keep, line for line.
    private var theSeal: some View {
        Panel("The seal") {
            if !seal.isSealed {
                Text("No seal set. Anything that weakens your fortress goes through a ten-second gate.")
                    .foregroundStyle(Theme.parchment)
            } else if seal.isRecovering {
                Text("Set — but a recovery is running, and will lift it.")
                    .foregroundStyle(Theme.parchment)
            } else {
                Text("Set. Taking a defence down asks for it first.")
                    .foregroundStyle(Theme.parchment)
            }
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
