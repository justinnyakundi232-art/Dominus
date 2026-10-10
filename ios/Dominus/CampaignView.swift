import SwiftUI

// The Campaign: the extension's Track Your Progress, on a phone.
//
// The same three things in the same words — the victory rate and its meter,
// the two streaks, and twenty-six weeks of history, a square per day. The
// figures are Stats.js's and every day is named, described and shaded by
// TrackProgress.js; this file only draws what it is handed.
//
// What it cannot borrow is hovering. The extension describes a day when the
// pointer rests on its square, and on a phone twenty-six weeks across the
// screen makes a square too small to aim at. So the day being read is named
// in large type above the grid, with an arrow either side to step through the
// days one at a time. Touching or sliding across the grid still picks a day,
// for anyone who wants to jump — but nothing depends on hitting a square.
struct CampaignView: View {
    @EnvironmentObject private var record: Record

    // The day being described. Today, until a finger says otherwise.
    @State private var selected: String?

    var body: some View {
        Page("The Campaign", subtitle: "A wise commander studies the battlefield before the next advance.", emblem: "Medieval_Strategy") {
            victoryRate
            streaks
            if let campaign = record.campaign {
                history(campaign)
            }
            if let failure = record.failure {
                Text("The record couldn't be read: \(failure)")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    // MARK: - Victory rate

    // The extension's meter: ten squares, lit by the rate to the nearest one.
    private var victoryRate: some View {
        Panel(
            "Victory rate",
            info: "Your victory rate is how often you hold the line — the share of blocked moments where you chose Stay focused instead of unlocking. It's Stay focused ÷ (Stay focused + Unlocks)."
        ) {
            let ratio = record.standing?.ratio
            Text(ratio.map { "\(Int(($0 * 100).rounded()))%" } ?? "No data yet")
                .font(.display(ratio == nil ? 28 : 44))
                .foregroundStyle(Theme.gold)
            HStack(spacing: 6) {
                let filled = Int(((ratio ?? 0) * 10).rounded())
                ForEach(0..<10, id: \.self) { index in
                    RoundedRectangle(cornerRadius: 4)
                        .fill(index < filled ? Theme.gold : Color(hex: 0x252525))
                        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Theme.gold, lineWidth: 1))
                        .aspectRatio(1, contentMode: .fit)
                }
            }
            // The laurel and the cracked shield that flank the meter in the
            // extension: what holding the line earns, and what giving way costs.
            HStack {
                Emblem(name: "Cracked_Shield", height: 44)
                Spacer()
                Emblem(name: "Laurel_Wreath", height: 44)
            }
        }
    }

    // MARK: - Streaks

    private var streaks: some View {
        VStack(spacing: 24) {
            Panel(
                "Discipline streak",
                info: "Days in a row with no unlock. A day nothing tested you still counts. An unlock ends the run, and the next clean day starts a new one."
            ) {
                line("Current", record.standing?.currentStreak, ("day", "days"))
                line("Longest", record.standing?.longestStreak, ("day", "days"))
            }
            Panel(
                "Resistance streak",
                info: "How many times in a row you chose Stay focused without unlocking anything. It counts choices, not days — every stand adds one, and a single unlock puts it back to zero. Your discipline streak measures clean days; this measures how often you held the line."
            ) {
                line("Current", record.standing?.currentResistance, ("stand", "stands"))
                line("Longest", record.standing?.longestResistance, ("stand", "stands"))
            }
        }
    }

    private func line(_ name: String, _ value: Int?, _ unit: (String, String)) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(name)
                .foregroundStyle(Theme.goldDim)
            Spacer()
            Text(value.map { "\($0) \($0 == 1 ? unit.0 : unit.1)" } ?? "–")
                .font(.display(20, relativeTo: .title3))
                .foregroundStyle(Theme.gold)
        }
    }

    // MARK: - History

    private func history(_ campaign: Record.Campaign) -> some View {
        Panel(
            "Streak history",
            info: "One square per day. A day is Held if you met a block and walked away every time, Slipped if you unlocked one, and Untested if nothing asked anything of you. Untested days keep your streak — they just weren't a fight. Days before your history begins are left blank rather than called untested, because Dominus wasn't recording them."
        ) {
            if campaign.summary.recorded == 0 {
                Text("History starts today. Every block you meet from here on fills a square.")
                    .font(.footnote)
                    .foregroundStyle(Theme.goldDim)
            } else {
                Text("\(campaign.summary.span) · \(campaign.summary.held) held · \(campaign.summary.slipped) slipped · \(campaign.summary.untested) untested")
                    .font(.footnote)
                    .foregroundStyle(Theme.goldDim)
            }

            if let day = described(in: campaign) {
                stepper(day, in: campaign)
            }

            HistoryGrid(campaign: campaign, selected: $selected)

            legend
        }
    }

    // The day being read, and the way to the ones either side of it. What the
    // extension shows in a tooltip.
    private func stepper(_ day: Record.Campaign.Day, in campaign: Record.Campaign) -> some View {
        let earlier = neighbour(of: day, by: -1, in: campaign)
        let later = neighbour(of: day, by: 1, in: campaign)

        return VStack(spacing: 10) {
            HStack(spacing: 12) {
                StepArrow(symbol: "chevron.left", enabled: earlier != nil, label: "Earlier day") {
                    move(by: -1, in: campaign)
                }
                VStack(spacing: 2) {
                    Text(day.label)
                        .font(.display(22, relativeTo: .title2))
                        .foregroundStyle(Theme.gold)
                    Text(day.today ? "\(day.stateLabel) · Today" : day.stateLabel)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.goldDim)
                }
                .frame(maxWidth: .infinity)
                StepArrow(symbol: "chevron.right", enabled: later != nil, label: "Later day") {
                    move(by: 1, in: campaign)
                }
            }
            Text(day.description)
                .foregroundStyle(Theme.parchment)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
            if !day.today {
                Button("Back to today") { selected = nil }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.gold)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity)
        .background(Theme.panel)
    }

    // One step from whichever day is being read now. Worked out afresh each
    // time rather than fixed when the arrow was drawn, because a held arrow
    // keeps calling this long after that.
    private func move(by step: Int, in campaign: Record.Campaign) {
        guard
            let day = described(in: campaign),
            let next = neighbour(of: day, by: step, in: campaign)
        else { return }
        selected = next.date
    }

    // The day one step earlier or later, or nil at either end. The earlier
    // end is where the record begins, not where the grid does: stepping back
    // through months of "before your history begins" would be a long walk to
    // nothing.
    private func neighbour(of day: Record.Campaign.Day, by step: Int, in campaign: Record.Campaign) -> Record.Campaign.Day? {
        guard let index = campaign.days.firstIndex(where: { $0.date == day.date }) else { return nil }
        let next = index + step
        guard campaign.days.indices.contains(next) else { return nil }
        let candidate = campaign.days[next]
        return candidate.state == .before ? nil : candidate
    }

    private func described(in campaign: Record.Campaign) -> Record.Campaign.Day? {
        campaign.days.first { $0.date == selected } ?? campaign.days.last
    }

    private var legend: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), alignment: .leading)], alignment: .leading, spacing: 8) {
            legendItem("Untested", .untested, 0)
            legendItem("Held", .held, 2)
            legendItem("Slipped", .slipped, 2)
            legendItem("From your streak", .inferred, 0)
            legendItem("No record", .before, 0)
        }
    }

    private func legendItem(_ name: String, _ state: Record.DayState, _ level: Int) -> some View {
        HStack(spacing: 8) {
            HeatSquare(state: state, level: level, today: false, selected: false)
                .frame(width: 12, height: 12)
            Text(name)
                .font(.caption)
                .foregroundStyle(Theme.goldDim)
        }
    }
}

// An arrow that steps once when tapped and keeps stepping while held. A
// full-size target, whatever the size of the squares.
//
// Half a year is a long way to go a tap at a time. Holding waits a moment, so
// a slow tap is still one step, and then walks at about nine days a second —
// quick enough to cross months, slow enough to stop on a day.
private struct StepArrow: View {
    let symbol: String
    let enabled: Bool
    let label: String
    let step: () -> Void

    @State private var holding: Task<Void, Never>?

    var body: some View {
        Image(systemName: symbol)
            .font(.title3.weight(.semibold))
            .foregroundStyle(enabled ? Theme.gold : Theme.goldDim.opacity(0.35))
            .frame(width: 44, height: 44)
            .overlay(Rectangle().stroke(enabled ? Theme.goldDim : Theme.goldDim.opacity(0.2), lineWidth: 1))
            .contentShape(Rectangle())
            // Never completes: it is only here to say when a finger goes down
            // and when it comes up.
            .onLongPressGesture(minimumDuration: .infinity, maximumDistance: 40, perform: {}, onPressingChanged: { pressing in
                release()
                if pressing && enabled {
                    press()
                }
            })
            // The end of the record, or of the grid: nothing further to walk to.
            .onChange(of: enabled) { enabled in
                if !enabled {
                    release()
                }
            }
            .onDisappear(perform: release)
            .accessibilityElement()
            .accessibilityLabel(label)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction {
                if enabled {
                    step()
                }
            }
    }

    private func press() {
        step()
        holding = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 450_000_000)
            while !Task.isCancelled {
                step()
                try? await Task.sleep(nanoseconds: 110_000_000)
            }
        }
    }

    private func release() {
        holding?.cancel()
        holding = nil
    }
}

// Weeks as columns, weekdays as rows, Sunday at the top — the extension's
// grid, sized to fit the width it is given rather than fixed at 14 pixels.
private struct HistoryGrid: View {
    let campaign: Record.Campaign
    @Binding var selected: String?

    private let gap: CGFloat = 2
    private let weekdayWidth: CGFloat = 26
    private let monthHeight: CGFloat = 14

    private var columns: Int { campaign.months.count }

    var body: some View {
        GeometryReader { proxy in
            let side = squareSide(in: proxy.size.width)

            VStack(alignment: .leading, spacing: 4) {
                // A month's name is wider than its column, so each is laid
                // over the column it starts at and allowed to run on.
                ZStack(alignment: .topLeading) {
                    ForEach(campaign.months.indices, id: \.self) { column in
                        if !campaign.months[column].isEmpty {
                            Text(campaign.months[column])
                                .font(.system(size: 9))
                                .foregroundStyle(Theme.goldDim)
                                .fixedSize()
                                .offset(x: weekdayWidth + CGFloat(column) * (side + gap))
                        }
                    }
                }
                .frame(height: monthHeight, alignment: .topLeading)

                HStack(alignment: .top, spacing: 0) {
                    VStack(spacing: gap) {
                        ForEach(campaign.weekdays.indices, id: \.self) { row in
                            Text(campaign.weekdays[row])
                                .font(.system(size: 9))
                                .foregroundStyle(Theme.goldDim)
                                .frame(width: weekdayWidth, height: side, alignment: .leading)
                        }
                    }

                    HStack(alignment: .top, spacing: gap) {
                        ForEach(0..<columns, id: \.self) { column in
                            VStack(spacing: gap) {
                                ForEach(0..<7, id: \.self) { row in
                                    square(column: column, row: row)
                                        .frame(width: side, height: side)
                                }
                            }
                        }
                    }
                    // Sliding reads a day; it does not stop the page from
                    // scrolling when the drag is really a scroll.
                    .contentShape(Rectangle())
                    .simultaneousGesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { value in
                                select(at: value.location, side: side)
                            }
                    )
                }
            }
        }
        .frame(height: height)
        .accessibilityElement()
        .accessibilityLabel("Streak history grid. The summary above gives its totals.")
    }

    // The side is not known until the width is, but the height has to be
    // given to the GeometryReader up front. So it is worked out from the
    // screen's width less the page's and the panel's padding, the same sum
    // the layout will do, and the squares are sized from the real width.
    private var height: CGFloat {
        let width = UIScreen.main.bounds.width - 2 * 24 - 2 * 20
        return monthHeight + 4 + 7 * squareSide(in: width) + 6 * gap
    }

    private func squareSide(in width: CGFloat) -> CGFloat {
        let room = width - weekdayWidth - CGFloat(max(columns - 1, 0)) * gap
        return max(4, (room / CGFloat(max(columns, 1))).rounded(.down))
    }

    // The first column is pushed down by `blanks`, exactly as the extension
    // pads it, so a square's place in the grid gives its place in the list.
    private func day(column: Int, row: Int) -> Record.Campaign.Day? {
        let index = column * 7 + row - campaign.blanks
        return campaign.days.indices.contains(index) ? campaign.days[index] : nil
    }

    @ViewBuilder
    private func square(column: Int, row: Int) -> some View {
        if let day = day(column: column, row: row) {
            HeatSquare(state: day.state, level: day.level, today: day.today, selected: day.date == selected)
        } else {
            Color.clear
        }
    }

    private func select(at point: CGPoint, side: CGFloat) {
        let step = side + gap
        let column = Int((point.x / step).rounded(.down))
        let row = Int((point.y / step).rounded(.down))
        guard (0..<columns).contains(column), (0..<7).contains(row) else { return }
        if let day = day(column: column, row: row), day.date != selected {
            selected = day.date
        }
    }
}

// One day. The colours are TrackProgress.css's, shade for shade.
private struct HeatSquare: View {
    let state: Record.DayState
    let level: Int
    let today: Bool
    let selected: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: 2)
            .fill(fill)
            .overlay(
                RoundedRectangle(cornerRadius: 2)
                    .strokeBorder(border, style: StrokeStyle(lineWidth: 1, dash: state == .inferred ? [2, 2] : []))
            )
            // Today, whatever state it is in — the grid should always say
            // where you are. The day being read is ringed in gold over that.
            .overlay(
                RoundedRectangle(cornerRadius: 2)
                    .stroke(selected ? Theme.gold : Color(hex: 0xB9C2CC), lineWidth: selected ? 1.5 : 1)
                    .padding(-1.5)
                    .opacity(selected || today ? 1 : 0)
            )
    }

    private var fill: Color {
        switch state {
        case .held:
            return [Color(hex: 0x5C4A12), Color(hex: 0x9A7A1E), Theme.gold][min(max(level, 1), 3) - 1]
        case .slipped:
            return [Color(hex: 0x5E2020), Color(hex: 0x8F2C2C), Color(hex: 0xC0392B)][min(max(level, 1), 3) - 1]
        case .untested:
            return Color(hex: 0x151515)
        // Outlines, not fills: an inferred day must never be mistaken for a
        // held one, and a day before the record is not a state at all.
        case .inferred, .before:
            return .clear
        }
    }

    private var border: Color {
        switch state {
        case .held, .slipped: return .clear
        case .untested: return Color(hex: 0x262626)
        case .inferred: return Color(hex: 0x6E5A1F)
        case .before: return Color(hex: 0x1C1C1C)
        }
    }
}
