// TrackProgress.js — populates The Campaign from the stats data layer
// (Stats.js, loaded before this script). Read-only: it calls getStats() and
// paints the victory rate, the 10-square meter, the streaks and the history.

// Every figure on this view can change while the user is somewhere else in the
// shell — a stand recorded on the blocked page moves all of them — so it is
// repainted from storage each time the view is shown rather than only at load.
// The router looks this name up; see refreshHookFor() in App.js.
//
// Safe to call repeatedly: every render below replaces its own content rather
// than appending to it.
function refreshCampaign() {
    Promise.all([getStats(), getDayHistory(HISTORY_WEEKS * 7)])
        .then(([stats, history]) => renderCampaign(stats, history));
}

// Draws the whole view from figures already in hand.
//
// Split from refreshCampaign() so the desktop app can use this file as it is:
// it has no chrome.storage, so it builds the same two things from the state the
// extension synced to it — standingFrom() and buildDayHistory() in Stats.js —
// and hands them here. One implementation of what The Campaign shows, the same
// way there is one of the merge rules.
//
// `stats` is the shape getStats() returns; `history` is getDayHistory()'s.
function renderCampaign(stats, history) {
    renderVictoryRate(stats);
    renderStreak(stats);
    renderStreakHistory(history);
}

// No DOMContentLoaded handler on purpose: the router calls this the first time
// the view is shown and on every visit after, so a user who never opens the
// campaign never pays for building a 26-week grid.

// Victory rate = Stay Focused / (Stay Focused + Unlocks). Fills the percentage
// text and lights up that share of the 10 squares. With no data yet (ratio
// null), show a friendly placeholder and leave every square empty.
function renderVictoryRate(stats) {
    const valueEl = document.getElementById("victoryValue");
    const bar = document.getElementById("progressBar");
    const squares = bar ? bar.querySelectorAll(".progress-square") : [];

    if (stats.ratio === null) {
        if (valueEl) valueEl.textContent = "No data yet";
        squares.forEach((square) => square.classList.remove("filled"));
        return;
    }

    const percent = Math.round(stats.ratio * 100);
    if (valueEl) valueEl.textContent = percent + "%";

    // Light the first N squares, where N is the rate rounded to the nearest
    // square (e.g. 70% of 10 squares -> 7 filled).
    const filled = Math.round(stats.ratio * squares.length);
    squares.forEach((square, index) => {
        square.classList.toggle("filled", index < filled);
    });
}

function renderStreak(stats) {
    // Discipline is measured in calendar days, resistance in individual
    // choices, so the two are deliberately given different units rather than
    // showing four bare numbers.
    setUnit(document.getElementById("currentStreak"), stats.currentStreak, "day", "days");
    setUnit(document.getElementById("longestStreak"), stats.longestStreak, "day", "days");

    setUnit(document.getElementById("currentResistance"), stats.currentResistance, "stand", "stands");
    setUnit(document.getElementById("longestResistance"), stats.longestResistance, "stand", "stands");
}

// "1 day" vs "N days", "1 stand" vs "N stands".
function setUnit(el, n, singular, plural) {
    if (el) el.textContent = n + " " + (n === 1 ? singular : plural);
}

// ---- Streak history --------------------------------------------------------
//
// A square per day for the last HISTORY_WEEKS weeks: weeks as columns, weekdays
// as rows. Everything below reads getDayHistory() and draws — no state of its
// own, and no writes.

const HISTORY_WEEKS = 26;

// Sunday-first, matching how the weekday index comes out of Date.getDay().
const WEEKDAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];
const MONTH_LABELS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];

// Intensity within a state. Deliberately coarse: three steps are readable at
// 14px, and the exact count is in the tooltip for anyone who wants it.
//
// Two ramps, written out separately, because the two things being measured are
// not the same size. Stands are cheap and come in handfuls; unlocks are rare
// and each one costs the day. Putting six of each at the top of its scale would
// mean a six-unlock day — which almost never happens — is the only one ever
// drawn in full red, so the slipped end of the grid would sit permanently in
// its darkest shade and say nothing.
//
// These used to share one function, with the slipped side passing `unlocks * 2`
// to borrow the thresholds meant for stands. That produced exactly the numbers
// below and was correct, but the relationship it encoded could only be read by
// doing the multiplication in your head, and a scale you have to solve is one
// nobody can check.
function standLevel(stands) {
    if (stands >= 6) return 3;
    if (stands >= 3) return 2;
    return 1;
}

function slipLevel(unlocks) {
    if (unlocks >= 3) return 3;
    if (unlocks >= 2) return 2;
    return 1;
}

// A local "YYYY-MM-DD" back to a Date at local midnight. Built from the parts
// rather than Date.parse, which reads a bare date string as UTC and can land on
// the wrong day west of Greenwich.
function dateFromLocalString(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(y, m - 1, d);
}

function formatDayLabel(dateStr) {
    const date = dateFromLocalString(dateStr);
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
    return `${weekday} ${date.getDate()} ${MONTH_LABELS[date.getMonth()]}`;
}

// The sentence under the date in the tooltip. This is the whole reason the day
// log records more than a boolean: "held" on its own says nothing about what it
// cost, and "slipped" says nothing about what gave way.
function describeDay(day) {
    const entry = day.entry;

    // Deliberately makes no claim about the day. Dominus has no record this far
    // back, and "you never met a blocked site" would be inventing one.
    if (day.state === "before") {
        return "This is before your history begins.";
    }

    if (day.state === "inferred") {
        return "Clean — drawn from your streak, before daily history began.";
    }

    if (day.state === "untested") {
        return "You never met a blocked site.";
    }

    const stands = entry.stands === 1 ? "1 stand" : `${entry.stands} stands`;

    if (day.state === "held") {
        return `${stands}, no unlocks.`;
    }

    // Slipped. Name the site that actually gave way, and when — the late-night
    // pattern is the useful thing here, and a bare count hides it.
    const gave = describeSlip(entry);
    const when = entry.firstSlip ? ` at ${entry.firstSlip}` : "";

    return entry.stands > 0
        ? `${stands}, then ${gave}${when}.`
        : `${gave}${when}.`;
}

// What gave way, in as many words as it takes to account for every unlock on
// the day — and never fewer.
//
// Naming only the worst site used to lose the count entirely. Three unlocks
// across three different sites left all three tied at one, so the ×N suffix was
// suppressed on each and the sentence read exactly like a single slip — sitting
// under a square drawn at full brightness, because the colour is scaled by the
// day's unlocks rather than by one site's share of them. The grid and its own
// tooltip contradicted each other, and the grid was the one telling the truth.
//
// So whatever the named site doesn't account for is stated too. The remainder
// is counted in unlocks rather than in sites, because unlocks are what coloured
// the square and because recordUnlock() takes its domain optionally: an unlock
// recorded without one belongs in that remainder, not nowhere.
function describeSlip(entry) {
    const sites = Object.keys(entry.sites)
        .sort((a, b) => entry.sites[b] - entry.sites[a]);

    // Nothing named the whole day. A real shape, not a corrupt one.
    if (sites.length === 0) {
        return entry.unlocks === 1 ? "one unlock" : `${entry.unlocks} unlocks`;
    }

    const worst = sites[0];
    const share = entry.sites[worst];
    const named = `${worst}${share > 1 ? ` ×${share}` : ""}`;
    const rest = entry.unlocks - share;

    return rest > 0 ? `${named}, +${rest} more` : named;
}

function stateLabel(state) {
    if (state === "held") return "Held";
    if (state === "slipped") return "Slipped";
    if (state === "inferred") return "Clean";
    if (state === "before") return "No record";
    return "Untested";
}

// One tooltip element for the whole grid, moved to whichever cell is hovered.
// 182 tooltips sitting in the DOM would be 182 absolutely positioned elements
// widening the page even while hidden.
//
// Returns a small controller rather than the element, because the tooltip has
// to keep track of which cell opened it — see the scroll and mouseleave notes
// below.
function createHeatTip() {
    const el = document.createElement("div");
    el.className = "heat-tip";
    el.setAttribute("role", "tooltip");
    document.body.appendChild(el);

    let active = null;

    // position:fixed and measured from getBoundingClientRect(), so both are in
    // viewport coordinates and this can simply be re-run whenever the cell
    // moves under the cursor.
    function position() {
        if (!active) return;

        const box = active.getBoundingClientRect();
        const tipBox = el.getBoundingClientRect();

        // Clamped, so a cell at either end of the grid doesn't push the
        // tooltip off screen.
        let left = box.left + (box.width / 2) - (tipBox.width / 2);
        left = Math.max(8, Math.min(left, window.innerWidth - tipBox.width - 8));

        let top = box.top - tipBox.height - 8;
        if (top < 8) top = box.bottom + 8;

        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
    }

    function show(cell, day) {
        active = cell;
        el.textContent = "";

        const date = document.createElement("span");
        date.className = "tip-date";
        date.textContent = `${formatDayLabel(day.date)} — ${stateLabel(day.state)}`;

        // Built as nodes, not innerHTML: the text includes a domain the user
        // typed into a category at some point.
        el.appendChild(date);
        el.appendChild(document.createTextNode(describeDay(day)));

        el.classList.add("visible");
        position();
    }

    // Only the cell that opened the tooltip may close it. Without that guard a
    // mouseleave arriving after the pointer has already entered the next cell
    // blanks a tooltip that has moved on.
    function hide(cell) {
        if (cell && active !== cell) return;
        active = null;
        el.classList.remove("visible");
    }

    // Scrolling moves the cell out from under a fixed tooltip, so the tooltip
    // follows it. It used to hide instead, which looked fine until you scrolled
    // with a trackpad: the momentum keeps firing scroll events for a moment
    // after you stop, so a tooltip opened right after scrolling to the grid
    // vanished while the cursor was still sitting on the square.
    //
    // Listened for on the document in the capture phase, because the scroll
    // that matters is rarely the window's. Both shells scroll a content pane,
    // and the grid scrolls sideways inside its own box on narrow windows —
    // element scroll events don't bubble, but they are captured.
    document.addEventListener("scroll", position, { passive: true, capture: true });
    window.addEventListener("resize", position, { passive: true });

    return { show: show, hide: hide };
}

// One tooltip for the life of the page. The grid is redrawn on every visit to
// the view, and making a new tooltip each time left the old ones — and their
// listeners — behind in the document.
let heatTip = null;

function heatTipFor() {
    if (!heatTip) heatTip = createHeatTip();
    return heatTip;
}

// Blank cells before the first day, so every row is one weekday all the way
// across. Without them the rows shear and "which weekday do I lose?" becomes
// unanswerable.
function leadingBlanks(firstDateStr) {
    return dateFromLocalString(firstDateStr).getDay();
}

function buildMonthLabels(history, blanks) {
    const row = document.createElement("div");
    row.className = "history-months";

    const columns = Math.ceil((history.length + blanks) / 7);
    row.style.gridTemplateColumns = `repeat(${columns}, 14px)`;

    let lastMonth = null;

    for (let column = 0; column < columns; column++) {
        const label = document.createElement("span");

        // The day sitting in this column's top row, which is what the label
        // has to agree with.
        const index = (column * 7) - blanks;
        const day = history[Math.max(0, index)];
        const month = day ? dateFromLocalString(day.date).getMonth() : null;

        // Only where the month turns over, and never in the first column — a
        // label there would sit over a partial week and read as a full month.
        if (month !== null && month !== lastMonth && column > 0) {
            label.textContent = MONTH_LABELS[month];
            lastMonth = month;
        }

        row.appendChild(label);
    }

    return row;
}

function buildWeekdayLabels() {
    const column = document.createElement("div");
    column.className = "history-weekdays";

    WEEKDAY_LABELS.forEach((text) => {
        const label = document.createElement("span");
        label.textContent = text;
        column.appendChild(label);
    });

    return column;
}

function buildCells(history, blanks, tip) {
    const cells = document.createElement("div");
    cells.className = "history-cells";

    for (let i = 0; i < blanks; i++) {
        const blank = document.createElement("span");
        blank.className = "heat-cell is-empty";
        cells.appendChild(blank);
    }

    const today = history.length ? history[history.length - 1].date : null;

    history.forEach((day) => {
        const cell = document.createElement("span");
        cell.className = `heat-cell heat-${day.state}`;

        if (day.state === "held") {
            cell.classList.add(`level-${standLevel(day.entry.stands)}`);
        } else if (day.state === "slipped") {
            cell.classList.add(`level-${slipLevel(day.entry.unlocks)}`);
        }

        if (day.date === today) cell.classList.add("is-today");

        // Announced rather than focusable: 182 tab stops would make the rest of
        // the page unreachable by keyboard, so the same facts are carried by
        // the summary line above the grid.
        cell.setAttribute("role", "img");
        cell.setAttribute("aria-label",
            `${formatDayLabel(day.date)}. ${stateLabel(day.state)}. ${describeDay(day)}`);

        cell.addEventListener("mouseenter", () => tip.show(cell, day));
        cell.addEventListener("mouseleave", () => tip.hide(cell));

        cells.appendChild(cell);
    });

    return cells;
}

// "26 weeks · 84 held · 9 slipped". Not decoration: it is how the grid's
// content reaches anyone who can't hover it.
function renderHistorySummary(history) {
    const el = document.getElementById("historySummary");
    if (!el) return;

    const counts = { held: 0, slipped: 0, untested: 0, inferred: 0, before: 0 };
    history.forEach((day) => { counts[day.state] += 1; });

    const recorded = counts.held + counts.slipped + counts.inferred;

    if (recorded === 0) {
        el.textContent =
            "History starts today. Every blocked site you meet from here on fills a square.";
        return;
    }

    el.textContent = "";

    // Days before the history began aren't counted — they aren't untested, they
    // simply aren't known — so the span is named by when the record starts
    // rather than by the width of the grid.
    const covered = history.find((day) => day.state !== "before");
    const span = counts.before > 0
        ? `Since ${formatDayLabel(covered.date).slice(4)}`
        : `${HISTORY_WEEKS} weeks`;

    const parts = [
        [span, false],
        [`${counts.held} held`, true],
        [`${counts.slipped} slipped`, true],
        [`${counts.untested} untested`, true]
    ];

    parts.forEach(([text, highlight], index) => {
        if (index > 0) el.appendChild(document.createTextNode(" · "));

        if (!highlight) {
            el.appendChild(document.createTextNode(text));
            return;
        }

        const span = document.createElement("span");
        span.className = "summary-value";
        span.textContent = text;
        el.appendChild(span);
    });
}

function renderStreakHistory(history) {
    const grid = document.getElementById("historyGrid");
    if (!grid || !history || !history.length) return;

    renderHistorySummary(history);

    const tip = heatTipFor();
    // The cells being replaced may be the one the tooltip is showing for.
    tip.hide();

    grid.textContent = "";

    const blanks = leadingBlanks(history[0].date);

    grid.appendChild(buildMonthLabels(history, blanks));
    grid.appendChild(buildWeekdayLabels());
    grid.appendChild(buildCells(history, blanks, tip));
}
