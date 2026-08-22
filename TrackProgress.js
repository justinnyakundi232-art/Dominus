// TrackProgress.js — populates the Track Your Progress page from the stats
// data layer (Stats.js, loaded before this script). Read-only: it calls
// getStats() and paints the victory rate, the 10-square meter, and the streak.

document.addEventListener("DOMContentLoaded", () => {
    getStats().then((stats) => {
        renderVictoryRate(stats);
        renderStreak(stats);
    });

    renderStreakHistory();
});

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
function heatLevel(count) {
    if (count >= 6) return 3;
    if (count >= 3) return 2;
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

    if (day.state === "inferred") {
        return "Clean — from your streak, before daily history began.";
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
    const sites = Object.keys(entry.sites);
    const worst = sites.sort((a, b) => entry.sites[b] - entry.sites[a])[0];

    const gave = worst
        ? `${worst}${entry.sites[worst] > 1 ? ` ×${entry.sites[worst]}` : ""}`
        : (entry.unlocks === 1 ? "one unlock" : `${entry.unlocks} unlocks`);

    const when = entry.firstSlip ? ` at ${entry.firstSlip}` : "";

    return entry.stands > 0
        ? `${stands}, then ${gave}${when}.`
        : `${gave}${when}.`;
}

function stateLabel(state) {
    if (state === "held") return "Held";
    if (state === "slipped") return "Slipped";
    if (state === "inferred") return "Clean";
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
    window.addEventListener("scroll", position, { passive: true });
    window.addEventListener("resize", position, { passive: true });

    // The grid scrolls horizontally inside its own box on narrow windows, and
    // an element's scroll event doesn't reach window.
    const scroller = document.querySelector(".history-scroll");
    if (scroller) scroller.addEventListener("scroll", position, { passive: true });

    return { show: show, hide: hide };
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
            cell.classList.add(`level-${heatLevel(day.entry.stands)}`);
        } else if (day.state === "slipped") {
            cell.classList.add(`level-${heatLevel(day.entry.unlocks * 2)}`);
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

    const counts = { held: 0, slipped: 0, untested: 0, inferred: 0 };
    history.forEach((day) => { counts[day.state] += 1; });

    const recorded = counts.held + counts.slipped + counts.inferred;

    if (recorded === 0) {
        el.textContent =
            "History starts today. Every blocked site you meet from here on fills a square.";
        return;
    }

    el.textContent = "";

    const parts = [
        [`${HISTORY_WEEKS} weeks`, false],
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

function renderStreakHistory() {
    const grid = document.getElementById("historyGrid");
    if (!grid) return;

    getDayHistory(HISTORY_WEEKS * 7).then((history) => {
        renderHistorySummary(history);

        grid.textContent = "";

        const blanks = leadingBlanks(history[0].date);
        const tip = createHeatTip();

        grid.appendChild(buildMonthLabels(history, blanks));
        grid.appendChild(buildWeekdayLabels());
        grid.appendChild(buildCells(history, blanks, tip));
    });
}
