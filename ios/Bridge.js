// Bridge.js — what a phone has to supply for the extension's scripts to run.
//
// Loaded first, before Tasks.js, Categories.js, Applications.js, Stats.js,
// Seal.js and Sync.js — the same set, in the same order, that the extension's
// service worker pulls in — and TrackProgress.js, for what The Campaign says
// about a day. All of them then run unchanged. Everything here stands
// in for the platform, never for a rule: the three things a browser gives
// those scripts that JavaScriptCore does not, and the ways Swift calls them.
//
// The functions named __dominus… below are supplied from Swift, in
// SharedRules.swift.

// ---- crypto ---------------------------------------------------------------
//
// Tasks.js's randomInt() draws from crypto.getRandomValues, and Sync.js names
// this device and each event with crypto.randomUUID. Both are backed by the
// system. crypto.subtle, which Seal.js hashes a password with, is not here
// yet: nothing calls it until a seal is set.

var crypto = {
    getRandomValues: function (array) {
        for (var i = 0; i < array.length; i++) array[i] = __dominusRandomUInt32();
        return array;
    },
    randomUUID: function () {
        return __dominusUUID();
    }
};

// ---- chrome.storage.local -------------------------------------------------
//
// Where the scripts keep everything: the stats and the day log, the
// categories, the unlock task and the cooldown, and Sync.js's event log and
// revisions. Backed by the App Group, one JSON string per key, so the whole
// fortress is the same shape on the phone as in Chrome — which is what will
// let it be merged, not converted, when the phone syncs.
//
// The callbacks run at once rather than later. Stats.js wraps every call in a
// promise, so it cannot tell the difference, and it means a whole chain of
// reads and writes has settled by the time Swift's call into it returns.

var chrome = {
    storage: {
        local: {
            get: function (keys, callback) {
                var result = {};
                (Array.isArray(keys) ? keys : [keys]).forEach(function (key) {
                    var raw = __dominusStorageRead(key);
                    if (raw !== null && raw !== undefined) result[key] = JSON.parse(raw);
                });
                callback(result);
            },
            set: function (items, callback) {
                Object.keys(items).forEach(function (key) {
                    __dominusStorageWrite(key, JSON.stringify(items[key]));
                });
                if (callback) callback();
            }
        }
    }
};

// ---- A clock that can be set ----------------------------------------------
//
// Stats.js stamps everything "now". But a stand made at the block screen is
// made while the app is not running: an extension records the time, and the
// app tells Stats.js about it whenever it is next opened — which may be the
// next day. Recorded as "now", that stand would land on the wrong square of
// the history grid.
//
// So the clock can be held at a moment while an event is replayed. Only
// `new Date()` with no arguments and Date.now() are affected; every other use
// of Date is the real one.

(function () {
    var RealDate = Date;
    var held = null;

    function ClockDate() {
        if (!(this instanceof ClockDate)) return RealDate();
        if (arguments.length === 0) {
            return held === null ? new RealDate() : new RealDate(held);
        }
        return new (Function.prototype.bind.apply(RealDate, [null].concat([].slice.call(arguments))))();
    }

    ClockDate.prototype = RealDate.prototype;
    ClockDate.now = function () { return held === null ? RealDate.now() : held; };
    ClockDate.parse = RealDate.parse;
    ClockDate.UTC = RealDate.UTC;

    Date = ClockDate;

    __dominusHoldClock = function (ms) { held = ms; };
    __dominusReleaseClock = function () { held = null; };
})();

var __dominusHoldClock;
var __dominusReleaseClock;

// ---- Calling in from Swift ------------------------------------------------

// Swift cannot await a promise. It can read a box after its call returns, by
// which time JavaScriptCore has run every queued step of the chain.
function __dominusSettle(promise) {
    var box = { done: false, value: null, error: null };
    Promise.resolve(promise).then(
        function (value) { box.done = true; box.value = value; },
        function (error) { box.done = true; box.error = String((error && error.message) || error); }
    );
    return box;
}

// Records events at the times they happened, oldest first.
//   events: [{ type: "stand" | "slip", at: <ms since epoch>, domain?: string }]
// With no `at`, an event is recorded as now.
function __dominusRecord(events) {
    var chain = Promise.resolve();

    events.forEach(function (event) {
        chain = chain.then(function () {
            if (typeof event.at === "number") __dominusHoldClock(event.at);
            return event.type === "slip"
                ? recordUnlock(event.domain || undefined)
                : recordStayFocused();
        }).then(__dominusReleaseClock, function (error) {
            __dominusReleaseClock();
            throw error;
        });
    });

    return chain.then(function () { return events.length; });
}

// Where the fortress stands, for The Keep: Stats.js's own view, and today's
// day from its own history. As JSON, which crosses into Swift cleanly.
function __dominusStanding() {
    return getStats().then(function (view) {
        return getDayHistory(1).then(function (history) {
            var today = history[history.length - 1];
            return JSON.stringify({
                standing: view,
                todayState: today.state,
                today: today.entry
            });
        });
    });
}

// ---- The fortress ---------------------------------------------------------
//
// Seal.js's commitFortress() is the extension's one way to change a fortress:
// read it, work out what the edit takes down, ask for the seal if it is set,
// stamp the commit, write. The asking is built out of page elements there, so
// the phone cannot call it whole. These are the same steps with the asking
// left to Swift — each one still the extension's own function, so what counts
// as a weakening, what is written, and what a peer is later told are decided
// in one place.
//
// Fortresses cross as JSON text in both directions. It keeps `task: null`
// ("deliberately no task") distinct from a missing key ("leave it alone"),
// which is the distinction fillFortressState() turns on.

function __dominusEdited(nextJSON, before) {
    var next = JSON.parse(nextJSON);
    if (Array.isArray(next.categories)) {
        next.categories = normalizeCategoryList(next.categories);
    }
    if (Array.isArray(next.manualSites)) {
        next.manualSites = parseSiteList(next.manualSites.join("\n"));
    }
    return fillFortressState(next, before);
}

// The fortress as stored, with what a screen needs beside it: the derived
// block list, the colours a category may take, and the gate's length.
function __dominusFortress() {
    return readFortress().then(function (fortress) {
        return JSON.stringify({
            categories: fortress.categories,
            manualSites: fortress.manualSites,
            task: fortress.task,
            cooldown: fortress.cooldown,
            blockedSites: computeBlockedSites(fortress.categories, fortress.manualSites),
            palette: CATEGORY_COLORS,
            glyphs: CATEGORY_GLYPHS,
            taskTypes: TASK_TYPES,
            removeCooldownSeconds: REMOVE_COOLDOWN_SECONDS,
            minCooldownSeconds: MIN_COOLDOWN_SECONDS,
            maxCooldownSeconds: MAX_COOLDOWN_SECONDS,
            minEscalationFactor: MIN_ESCALATION_FACTOR
        });
    });
}

// What an edit would take down, in the words the extension's seal prompt uses.
// An empty list is a strengthening, which is free.
//
// `changeOnly` is true when everything listed comes from swapping one unlock
// task for another, or replacing a Guarded Code. The extension counts those —
// whether a passage is weaker than a code has no honest answer, and leaving
// a swap uncounted would make it a way around the seal — but its own line
// says "changed", not "weakened", and a gate that announces defences coming
// down over a change of task is saying something that may not be true. So the
// wait is the same and the words are not. It is worked out by asking
// describeWeakening() again with the task put back, rather than by reading
// its sentences.
function __dominusReview(nextJSON) {
    return readFortress().then(function (before) {
        var after = __dominusEdited(nextJSON, before);
        var lines = describeWeakening(before, after);
        var changeOnly = false;

        if (lines.length && before.task && after.task) {
            var taskPutBack = Object.assign({}, after, { task: before.task });
            changeOnly = describeWeakening(before, taskPutBack).length === 0;
        }

        return JSON.stringify({ weakenings: lines, changeOnly: changeOnly });
    });
}

// Stamps and writes the edit. Whether it may be made is decided before this
// is called.
function __dominusCommit(nextJSON) {
    return readFortress().then(function (before) {
        var after = __dominusEdited(nextJSON, before);
        return stampCommit(before, after)
            .then(function () { return writeFortress(after); })
            .then(function (result) {
                return JSON.stringify({ blockedSites: result.blockedSites });
            });
    });
}

// The task and cooldown that govern an unlock: a site's category may set its
// own, and a picked app, which has no name to look up, takes the fortress's.
function __dominusStandards(domain) {
    return readFortress().then(function (fortress) {
        var named = typeof domain === "string" && domain.length > 0;
        return JSON.stringify({
            task: named
                ? resolveTaskForDomain(fortress.categories, domain, fortress.task)
                : fortress.task,
            cooldown: named
                ? resolveCooldownForDomain(fortress.categories, domain, fortress.cooldown)
                : normalizeCooldown(fortress.cooldown),
            permanent: named ? isPermanentDomain(fortress.categories, domain) : false
        });
    });
}

// ---- The Campaign ---------------------------------------------------------
//
// TrackProgress.js draws The Campaign into a page, which a phone has not got.
// But what a day is called, how it is described, how deeply it is shaded and
// how many weeks are shown are all plain functions and constants in that file,
// so the phone asks them rather than deciding for itself. Each day arrives
// already labelled, described and levelled; Swift only draws squares.
//
// Two small things are worked out here because TrackProgress.js works them out
// while building page elements, and there is no calling that half without the
// other: which columns carry a month's name, and the summary line's counts.
// They follow buildMonthLabels() and renderHistorySummary() step for step.

function __dominusCampaign() {
    return Promise.all([getStats(), getDayHistory(HISTORY_WEEKS * 7)]).then(function (results) {
        var stats = results[0];
        var history = results[1];

        var blanks = history.length ? leadingBlanks(history[0].date) : 0;
        var today = history.length ? history[history.length - 1].date : null;

        // As buildMonthLabels(): a name only where the month turns over, read
        // off the day in the column's top row, and never in the first column,
        // where it would sit over a partial week and read as a full month.
        var columns = Math.ceil((history.length + blanks) / 7);
        var months = [];
        var lastMonth = null;
        for (var column = 0; column < columns; column++) {
            var top = history[Math.max(0, (column * 7) - blanks)];
            var month = top ? dateFromLocalString(top.date).getMonth() : null;
            if (month !== null && month !== lastMonth && column > 0) {
                months.push(MONTH_LABELS[month]);
                lastMonth = month;
            } else {
                months.push("");
            }
        }

        // As renderHistorySummary(): days before the history began are not
        // counted — they are not untested, they simply are not known — so the
        // span is named by when the record starts.
        var counts = { held: 0, slipped: 0, untested: 0, inferred: 0, before: 0 };
        history.forEach(function (day) { counts[day.state] += 1; });
        var covered = history.find(function (day) { return day.state !== "before"; });

        return JSON.stringify({
            standing: stats,
            weeks: HISTORY_WEEKS,
            blanks: blanks,
            months: months,
            weekdays: WEEKDAY_LABELS,
            summary: {
                recorded: counts.held + counts.slipped + counts.inferred,
                span: counts.before > 0 && covered
                    ? "Since " + formatDayLabel(covered.date).slice(4)
                    : HISTORY_WEEKS + " weeks",
                held: counts.held,
                slipped: counts.slipped,
                untested: counts.untested
            },
            days: history.map(function (day) {
                return {
                    date: day.date,
                    state: day.state,
                    level: day.state === "held" ? standLevel(day.entry.stands)
                        : day.state === "slipped" ? slipLevel(day.entry.unlocks)
                        : 0,
                    label: formatDayLabel(day.date),
                    stateLabel: stateLabel(day.state),
                    description: describeDay(day),
                    today: day.date === today
                };
            })
        });
    });
}
