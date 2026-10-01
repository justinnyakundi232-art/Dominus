// Bridge.js — what a phone has to supply for the extension's scripts to run.
//
// Loaded first, before Categories.js, Tasks.js and Stats.js, which then run
// unchanged. Everything here stands in for the platform, never for a rule:
// the three things a browser gives those scripts that JavaScriptCore does not,
// and two ways for Swift to call them.
//
// The functions named __dominus… below are supplied from Swift, in
// SharedRules.swift.

// ---- crypto ---------------------------------------------------------------
//
// Tasks.js's randomInt() draws from crypto.getRandomValues. Backed by the
// system's secure generator.

var crypto = {
    getRandomValues: function (array) {
        for (var i = 0; i < array.length; i++) array[i] = __dominusRandomUInt32();
        return array;
    }
};

// ---- chrome.storage.local -------------------------------------------------
//
// Stats.js keeps `stats` and `dayLog` here. Backed by the App Group, one JSON
// string per key, so the fortress's record is the same shape on the phone as
// in Chrome — which is what will let it be merged, not converted, when the
// phone syncs.
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
