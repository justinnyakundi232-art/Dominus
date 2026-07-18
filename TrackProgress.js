// TrackProgress.js — populates the Track Your Progress page from the stats
// data layer (Stats.js, loaded before this script). Read-only: it calls
// getStats() and paints the victory rate, the 10-square meter, and the streak.

document.addEventListener("DOMContentLoaded", () => {
    getStats().then((stats) => {
        renderVictoryRate(stats);
        renderStreak(stats);
    });
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
    setDays(document.getElementById("currentStreak"), stats.currentStreak);
    setDays(document.getElementById("longestStreak"), stats.longestStreak);
}

// "1 day" vs "N days".
function setDays(el, n) {
    if (el) el.textContent = n + (n === 1 ? " day" : " days");
}
