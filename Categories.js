// Categories.js — the shared category model.
//
// Loaded by the popup, the blocked page and Build Fortress, so all three agree
// on what a category is, which sites belong to it, and which task governs a
// given domain.
//
// Before 1.8 the category list was a hardcoded object duplicated in
// BuildFortress.js and Blocked.js. Two copies of the same literal meant a site
// added to one was invisible to the other, and user-defined categories were
// impossible. That object now lives in storage, seeded once from the defaults
// below.
//
// Dependency-free classic script, same as Tasks.js: top-level declarations, no
// storage or DOM access at load time, safe to include from any page in any
// order. It does read Tasks.js helpers (normalizeCooldown) inside functions, so
// Tasks.js must be loaded alongside it — but not necessarily first.

// ---- Storage keys ---------------------------------------------------------

// The ordered list of categories. Order is meaningful: when a domain sits in
// more than one enabled category, the earliest one governs its task.
const CATEGORY_DEFS_KEY = "categoryDefs";

// Domains blocked straight from the popup, with no category behind them.
// Tracked apart from blockedSites so unticking a category can't delete a block
// the category never created — see computeBlockedSites().
const MANUAL_SITES_KEY = "manualSites";

// ---- Appearance -----------------------------------------------------------

// A category's colour is chosen from a fixed set rather than a free colour
// input. Dominus is black and gold throughout, and an arbitrary picker would
// let one category be #00FF00 and wreck the page — these are heraldic banner
// colours, all of which hold up against a black ground.
const CATEGORY_COLORS = [
    { id: "gold", name: "Gold", value: "#D4AF37" },
    { id: "crimson", name: "Crimson", value: "#C0392B" },
    { id: "azure", name: "Azure", value: "#4A8FE0" },
    { id: "verdant", name: "Verdant", value: "#4BA96A" },
    { id: "royal", name: "Royal", value: "#9B6BD0" },
    { id: "silver", name: "Silver", value: "#B9C2CC" },
    { id: "copper", name: "Copper", value: "#CE8842" },
    { id: "sable", name: "Sable", value: "#8B95A3" }
];

// Marks, not emoji. An emoji set would fight the serif-and-gold styling and
// render differently on every platform; these are plain glyphs that take the
// category's colour and sit on the baseline like type.
const CATEGORY_GLYPHS = ["◆", "●", "▲", "■", "✦", "❖", "✚", "⬢"];

// Deterministic fallback so a category always has a banner, whether it was made
// before 1.8 added them or created without the user choosing one.
function defaultAppearance(index) {
    return {
        color: CATEGORY_COLORS[index % CATEGORY_COLORS.length].id,
        glyph: CATEGORY_GLYPHS[index % CATEGORY_GLYPHS.length]
    };
}

// The hex a category actually renders in. Falls back to gold rather than
// throwing if storage holds a colour id this version doesn't know.
function categoryColorValue(category) {
    const match = CATEGORY_COLORS.find((c) => c.id === (category && category.color));
    return match ? match.value : CATEGORY_COLORS[0].value;
}

// ---- Defaults -------------------------------------------------------------

// Seeds on first run only. After that the stored copy is authoritative, so
// editing this list will not retroactively change anyone's fortress — which is
// the point: a category the user has edited is theirs, not ours.
const DEFAULT_CATEGORIES = [
    {
        id: "socialMedia",
        name: "Social Media",
        color: "crimson",
        glyph: "◆",
        sites: [
            "facebook.com",
            "instagram.com",
            "reddit.com",
            "x.com",
            "tiktok.com",
            "snapchat.com"
        ]
    },
    {
        id: "videoStreaming",
        name: "Video Streaming",
        color: "azure",
        glyph: "▲",
        sites: [
            "youtube.com",
            "netflix.com",
            "twitch.tv",
            "hulu.com",
            "disneyplus.com"
        ]
    },
    {
        id: "gaming",
        name: "Gaming",
        color: "verdant",
        glyph: "●",
        sites: [
            "roblox.com",
            "steamcommunity.com",
            "epicgames.com",
            "miniclip.com"
        ]
    }
];

const MAX_CATEGORY_NAME_LENGTH = 40;

// ---- Domain normalisation -------------------------------------------------

// Everything else in Dominus keys off a bare hostname — Background.js compares
// against `hostname.replace(/^www\./, "")`, and so do tempUnlocks and the
// escalation counter. Category site lists have to land in exactly that shape or
// a block silently never fires, so anything a user types is put through here:
// a pasted "https://www.youtube.com/feed" has to become "youtube.com".
function normalizeDomain(raw) {
    let value = String(raw || "").trim().toLowerCase();
    if (!value) return "";

    // Strip a scheme if one was pasted, then everything from the first slash,
    // question mark or hash onwards.
    value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    value = value.split(/[/?#]/)[0];

    // Drop credentials and a port if present.
    value = value.split("@").pop();
    value = value.split(":")[0];

    value = value.replace(/^www\./, "");

    // Reject anything that isn't plausibly a hostname, rather than storing a
    // entry that can never match a real navigation.
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) return "";

    return value;
}

// Parses the category site editor (one domain per line) into a clean,
// de-duplicated list. Invalid lines are dropped rather than rejected, so a
// stray blank line or a pasted URL never blocks a save.
function parseSiteList(text) {
    const seen = new Set();

    String(text || "")
        .split(/[\n,]/)
        .forEach((line) => {
            const domain = normalizeDomain(line);
            if (domain) seen.add(domain);
        });

    return [...seen];
}

// ---- Normalisation --------------------------------------------------------

// Coerces one stored (or freshly built) category into the full shape, so no
// caller has to guard against a missing field.
//
// `task` and `cooldown` are deliberately three-state:
//   undefined -> inherit the fortress default
//   null      -> this category explicitly has no task
//   object    -> this category's own override
// JSON drops undefined properties on the way into chrome.storage but preserves
// null, so the distinction survives a round trip — the same convention
// readTaskForm() already uses on the fortress page.
function normalizeCategory(raw, index) {
    const source = raw || {};
    const fallback = defaultAppearance(index);

    const category = {
        id: String(source.id || `custom-${Date.now()}-${index}`),
        name: String(source.name || "Untitled").slice(0, MAX_CATEGORY_NAME_LENGTH),
        sites: Array.isArray(source.sites)
            ? parseSiteList(source.sites.join("\n"))
            : [],
        enabled: source.enabled === true,
        permanent: source.permanent === true,

        // Validated against the fixed sets, so a category saved by a newer
        // version (or hand-edited storage) can't render an unknown colour or an
        // arbitrary string in place of a mark.
        color: CATEGORY_COLORS.some((c) => c.id === source.color)
            ? source.color
            : fallback.color,
        glyph: CATEGORY_GLYPHS.includes(source.glyph)
            ? source.glyph
            : fallback.glyph
    };

    if ("task" in source) {
        category.task = source.task || null;
    }

    if ("cooldown" in source && source.cooldown) {
        category.cooldown = normalizeCooldown(source.cooldown);
    }

    return category;
}

// A category can only be permanent while it is actually switched on. Storing
// permanence on a disabled category would let a stale flag silently re-apply
// the next time it was ticked — the same reason wireCategoryToggle() clears the
// checkbox in the UI.
function normalizeCategoryList(raw) {
    if (!Array.isArray(raw)) return null;

    return raw.map((entry, index) => {
        const category = normalizeCategory(entry, index);
        if (!category.enabled) category.permanent = false;
        return category;
    });
}

// ---- Loading and migration ------------------------------------------------

// Builds the initial category list for a fortress that has never had one,
// carrying over the enabled/permanent flags from the pre-1.8 `categorySettings`
// key so upgrading doesn't quietly switch someone's blocks off.
function seedCategories(legacySettings) {
    const settings = legacySettings || {};

    return DEFAULT_CATEGORIES.map((preset, index) => normalizeCategory({
        id: preset.id,
        name: preset.name,
        color: preset.color,
        glyph: preset.glyph,
        sites: preset.sites.slice(),
        enabled: settings[preset.id]?.enabled === true,
        permanent: settings[preset.id]?.permanent === true
    }, index));
}

// Works out which blocked sites were added by hand, for a fortress upgrading
// from a version that never recorded it. Anything in blockedSites that no
// enabled category accounts for must have come from the popup's BLOCK SITE
// button, so it is preserved as a manual entry — otherwise the first save after
// upgrading would drop every ad-hoc block.
function deriveManualSites(categories, blockedSites) {
    const owned = new Set();

    categories.forEach((category) => {
        if (!category.enabled) return;
        category.sites.forEach((site) => owned.add(site));
    });

    return (blockedSites || [])
        .map(normalizeDomain)
        .filter((domain) => domain && !owned.has(domain));
}

// The single entry point for reading the category model. Every page calls this
// rather than touching the storage keys directly, so migration only has to
// happen in one place.
//
// Resolves to { categories, manualSites }. It writes the migrated shape back
// when it had to build one, so the derivation above only ever runs once.
function loadCategories() {
    return new Promise((resolve) => {
        chrome.storage.local.get(
            [CATEGORY_DEFS_KEY, MANUAL_SITES_KEY, "categorySettings", "blockedSites"],
            (result) => {
                const stored = normalizeCategoryList(result[CATEGORY_DEFS_KEY]);
                const categories = stored || seedCategories(result.categorySettings);

                const manualStored = Array.isArray(result[MANUAL_SITES_KEY])
                    ? result[MANUAL_SITES_KEY].map(normalizeDomain).filter(Boolean)
                    : null;

                const manualSites = manualStored
                    || deriveManualSites(categories, result.blockedSites);

                // Only write when something actually had to be migrated, so a
                // plain read doesn't churn storage on every page load.
                if (!stored || !manualStored) {
                    chrome.storage.local.set({
                        [CATEGORY_DEFS_KEY]: categories,
                        [MANUAL_SITES_KEY]: manualSites
                    });
                }

                resolve({ categories: categories, manualSites: manualSites });
            }
        );
    });
}

// ---- Derived state --------------------------------------------------------

// blockedSites is what Background.js reads on every navigation, so it stays a
// flat array of bare domains. It is now *derived* rather than edited in place:
// the union of every enabled category's sites and the manual list.
//
// Deriving it is what fixes the pre-1.8 bug where ticking and unticking a
// category deleted a site the user had blocked by hand from the popup — the
// category used to delete its whole preset list on the way out, including
// domains it never added.
function computeBlockedSites(categories, manualSites) {
    const blocked = new Set(manualSites || []);

    (categories || []).forEach((category) => {
        if (!category.enabled) return;
        category.sites.forEach((site) => blocked.add(site));
    });

    return [...blocked];
}

// Every enabled category holding this domain, in list order. Disabled
// categories are skipped: their sites aren't blocked, so they can't be the
// reason a site is blocked.
function categoriesForDomain(categories, domain) {
    if (!domain) return [];

    return (categories || []).filter(
        (category) => category.enabled && category.sites.includes(domain)
    );
}

// The category whose standards apply, when a domain sits in several.
//
// First-in-list-order wins rather than anything cleverer: "strictest task"
// isn't well defined (is a Guarded Code harder than a passage?), and a rule the
// user can't predict is worse than a simple one they can. The blocked page
// names the governing category so the answer is always on screen.
function governingCategory(categories, domain) {
    return categoriesForDomain(categories, domain)[0] || null;
}

// Permanence is the one setting that does resolve most-restrictive: if any
// category holding this domain is permanent, the domain is permanent. Taking
// the governing category's flag instead would let a second, laxer category
// quietly reopen a site the user had sealed.
function isPermanentDomain(categories, domain) {
    return categoriesForDomain(categories, domain)
        .some((category) => category.permanent);
}

// The task that governs a domain: the governing category's override if it
// declared one, otherwise the fortress-wide task. `undefined` on the category
// means "inherit"; `null` means "this category deliberately has no task", which
// has to beat a fortress-wide task rather than fall back to it.
function resolveTaskForDomain(categories, domain, fortressTask) {
    const category = governingCategory(categories, domain);

    if (category && "task" in category) {
        return category.task;
    }

    return fortressTask || null;
}

// Same inheritance rule for the cooldown. Kept separate from the task because
// the cooldown also applies when there is no task at all — the reason it lives
// under its own storage key rather than nested inside unlockTask.
function resolveCooldownForDomain(categories, domain, fortressCooldown) {
    const category = governingCategory(categories, domain);

    if (category && category.cooldown) {
        return normalizeCooldown(category.cooldown);
    }

    return normalizeCooldown(fortressCooldown);
}

// Display helper for the popup's per-site subtext. Returns the names of every
// category accounting for this block, or null when nothing does — in which case
// the caller says so rather than inventing a category.
function categoryNamesForDomain(categories, domain) {
    const names = categoriesForDomain(categories, domain)
        .map((category) => category.name);

    return names.length ? names : null;
}

// The categories holding a domain *besides* the one that governs it. The popup
// groups a site under its governing category, so these are the memberships that
// would otherwise be invisible.
function secondaryCategoriesForDomain(categories, domain) {
    return categoriesForDomain(categories, domain).slice(1);
}

// Arranges every blocked site into the groups the popup lists them under: one
// per enabled category that actually holds something, in fortress order, then
// everything else.
//
// A site is filed under its *governing* category only, never repeated. Listing
// it once per membership would make the list longer than the block list
// actually is, and imply the site is blocked several times over.
function groupBlockedSites(categories, manualSites) {
    const blocked = computeBlockedSites(categories, manualSites);
    const groups = [];
    const filed = new Set();

    (categories || []).forEach((category) => {
        if (!category.enabled) return;

        const sites = blocked.filter((domain) =>
            !filed.has(domain)
            && governingCategory(categories, domain) === category
        );

        if (!sites.length) return;

        sites.forEach((domain) => filed.add(domain));
        groups.push({ category: category, sites: sites.sort() });
    });

    // Anything no enabled category accounts for: blocked by hand from the
    // popup, or left behind by a category that has since been switched off.
    const loose = blocked.filter((domain) => !filed.has(domain)).sort();
    if (loose.length) {
        groups.push({ category: null, sites: loose });
    }

    return groups;
}
