// App.js — the router.
//
// Dominus is one window now. This decides which view is showing, keeps the rail
// in step with it, and gives each view somewhere to say "I need refreshing".
//
// Deliberately small. Every view's markup is already in the document (see the
// design note at the top of Styles/App.css), so routing is showing and hiding
// rather than building and tearing down — which is what makes a half-finished
// fortress edit survive a trip to the campaign and back.

const ROUTES = ["keep", "fortress", "campaign", "seal", "order"];
const DEFAULT_ROUTE = "keep";

// Where each view was scrolled to when the user last left it. Without this
// every view inherits the last one's offset, and the campaign opens halfway
// down the history grid because the fortress was scrolled that far.
//
// The scroll lives on the content pane rather than the window: the shell is one
// viewport tall and only .view-region scrolls, which is what keeps the rail
// from sliding away. See the layout note in Styles/App.css.
const scrollPositions = {};

function scroller() {
    return document.querySelector(".view-region");
}

let currentRoute = null;

// ---- Refresh hooks --------------------------------------------------------
//
// A view that reads storage needs to re-read it when it is shown again — the
// campaign's numbers change every time you stand your ground. A view that holds
// an unsaved working copy must NOT be refreshed, because that would throw the
// user's edit away; the fortress deliberately has no hook here.
//
// Looked up by name rather than registered, because these are classic scripts
// sharing one global scope and App.js loads last, so anything that exists is
// already defined by now.
function refreshHookFor(route) {
    if (route === "campaign" && typeof refreshCampaign === "function") return refreshCampaign;
    if (route === "keep" && typeof refreshKeep === "function") return refreshKeep;
    return null;
}

// ---- Routing --------------------------------------------------------------

function routeFromHash() {
    const raw = (location.hash || "").replace(/^#\/?/, "");
    return ROUTES.includes(raw) ? raw : DEFAULT_ROUTE;
}

function show(route) {
    if (route === currentRoute) {
        // Re-selecting the current view still refreshes it. Clicking THE
        // CAMPAIGN while already on it should read as "show me the latest",
        // not as nothing happening.
        const hook = refreshHookFor(route);
        if (hook) hook();
        return;
    }

    const pane = scroller();
    if (currentRoute && pane) scrollPositions[currentRoute] = pane.scrollTop;

    ROUTES.forEach((name) => {
        const view = document.getElementById(`view-${name}`);
        if (view) view.classList.toggle("is-active", name === route);
    });

    document.querySelectorAll(".rail-link").forEach((link) => {
        const active = link.dataset.route === route;
        if (active) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
    });

    currentRoute = route;

    const hook = refreshHookFor(route);
    if (hook) hook();

    // After the hook, so a view that just rebuilt its content is tall enough
    // for the position to still exist.
    if (pane) pane.scrollTop = scrollPositions[route] || 0;
}

// Everything routes through the hash, including the rail, so the browser's back
// button works and a view can be linked to directly — which is what lets the
// popup and the blocked page open Dominus *at* a particular view rather than at
// the front door.
function navigate(route) {
    if (!ROUTES.includes(route)) route = DEFAULT_ROUTE;

    if (routeFromHash() === route) {
        show(route);
        return;
    }

    location.hash = `#/${route}`;
}

// ---- The rail's standing line ---------------------------------------------

// The streak, kept current in the rail from wherever you are. A discipline
// streak you have to navigate to is one you forget you are carrying.
function renderRailStanding() {
    const value = document.getElementById("railStreak");
    const label = document.getElementById("railStreakLabel");
    if (!value || !label) return;

    return getStats().then((stats) => {
        value.textContent = stats.currentStreak;
        // Unit-suffixed, the same way the campaign labels its two streaks, so a
        // bare number in the corner can't be read as counting something else.
        label.textContent = stats.currentStreak === 1 ? "day held" : "days held";
    });
}

// ---- Wiring ---------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
    // One delegated listener rather than one per button, so the Keep's
    // "Build the fortress →" links work with no extra wiring, and so do any
    // added later.
    document.addEventListener("click", (event) => {
        const target = event.target.closest("[data-route]");
        if (!target || target.disabled) return;
        event.preventDefault();
        navigate(target.dataset.route);
    });

    window.addEventListener("hashchange", () => show(routeFromHash()));

    show(routeFromHash());
    renderRailStanding();

    // The seal recovery notice belongs wherever the user actually goes, which
    // is now the Keep. Same call the popup and the blocked page make.
    const notice = document.getElementById("keepSealNotice");
    if (notice && typeof renderSealNotice === "function") renderSealNotice(notice);
});
