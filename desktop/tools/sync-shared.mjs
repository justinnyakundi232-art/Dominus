// sync-shared.mjs — copy the extension's shared design assets into the app.
//
//     node tools/sync-shared.mjs
//
// Runs from the npm predev / prebuild scripts, so it is never something anyone
// has to remember.
//
// Why a copy rather than a reference: Tauri bundles whatever is under
// `frontendDist` and nothing above it, so `../../Styles/Tokens.css` resolves in
// a dev server and then vanishes from the packaged app. A symlink would work on
// one platform and not the others.
//
// So the file is copied, and the copy is gitignored and carries a banner saying
// not to edit it. `Styles/Tokens.css` at the repo root stays the only place a
// colour is ever defined — which is the entire reason the desktop app lives in
// this repository rather than its own.
//
// The same argument, and now the same mechanism, applies to the merge rules.
// This window authors fortress edits — it works out what an edit gave up and
// stamps the record for it — and it does that by running the very `Sync.js` the
// extension runs, copied in here. A second implementation kept in step by hand
// is how the two peers would eventually disagree about what a weakening is, and
// the cost of that is a defence that quietly stops being enforced rather than a
// wrong colour.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "Styles", "Tokens.css");
const target = join(here, "..", "src", "styles", "tokens.css");

const banner = `/* GENERATED — do not edit.
 *
 * Copied from Styles/Tokens.css at the repository root by
 * desktop/tools/sync-tokens.mjs. Edit the source, not this.
 */

`;

try {
    const css = readFileSync(source, "utf8");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, banner + css, "utf8");
    console.log(`tokens: Styles/Tokens.css -> src/styles/tokens.css (${css.length} bytes)`);
} catch (error) {
    console.error(`tokens: could not copy from ${source}`);
    console.error(`  ${error.message}`);
    // A desktop build with no tokens renders unstyled, which is worse than not
    // building at all — every colour would fall back to the browser default on
    // a black-and-gold product.
    process.exit(1);
}

// The shared layer the window authors edits with. Dependency-free classic
// scripts that declare everything at the top level and touch nothing at load,
// which is the same contract that lets the service worker pull them in with
// importScripts() — so a <script> tag in index.html is all this takes.
//
// Only what the window actually uses. Seal.js is the extension's seal prompt
// and has no business running in here.
//
// Applications.js is here because Sync.js calls into it — the merge normalises
// an application list before touching it — and because this window is the only
// surface that can author an application edit at all. The browser cannot see a
// process.
//
// Stats.js and TrackProgress.js are here for The Campaign. The window draws it
// with the extension's own code rather than a second copy of it: Stats.js
// supplies standingFrom() and buildDayHistory(), which work from the synced
// state with no storage at all, and TrackProgress.js supplies renderCampaign().
// Stats.js also carries the extension's storage functions, which read
// chrome.storage and are never called here — the same load-anything,
// run-nothing contract every shared file keeps.
const SHARED = [
    "Tasks.js", "Categories.js", "Applications.js", "Stats.js", "Sync.js", "TrackProgress.js"
];

SHARED.forEach((file) => {
    const from = join(here, "..", "..", file);
    const to = join(here, "..", "src", "shared", file.toLowerCase());

    try {
        const js = readFileSync(from, "utf8");
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, jsBanner(file) + js, "utf8");
        console.log(`shared: ${file} -> src/shared/${file.toLowerCase()} (${js.length} bytes)`);
    } catch (error) {
        console.error(`shared: could not copy ${file}`);
        console.error(`  ${error.message}`);
        // Fatal, for the same reason the tokens are. A window with no merge
        // rules cannot work out what an edit gives up, and an edit committed
        // without its record is a weakening that never travels — the peer puts
        // the defence back on the next tick and nobody is told why.
        process.exit(1);
    }
});

function jsBanner(file) {
    return `// GENERATED — do not edit.
//
// Copied from ${file} at the repository root by desktop/tools/sync-shared.mjs.
// Edit the source, not this. The whole point is that the app and the extension
// run the same merge rules rather than two implementations of them.

`;
}

// The typeface, which tokens.css now @font-faces rather than importing from
// Google. The files have to sit beside the copy of tokens.css exactly as they
// sit beside the original, because the url() in it is relative — which is what
// lets one rule serve both surfaces instead of two rules drifting apart.
//
// Fatal on failure, like the tokens: a window with no font falls back to a
// system serif, which is a different product wearing the same colours.
const FONT_DIR = join(here, "..", "..", "Styles", "fonts");
const fontTarget = join(here, "..", "src", "styles", "fonts");

try {
    const files = readdirSync(FONT_DIR);
    mkdirSync(fontTarget, { recursive: true });
    files.forEach((name) => {
        writeFileSync(join(fontTarget, name), readFileSync(join(FONT_DIR, name)));
    });
    // OFL.txt is copied along with them deliberately. The licence requires the
    // font to travel with its notice, and a bundled font whose licence stayed
    // behind in the other half of the repository has not.
    console.log(`fonts:  Styles/fonts -> src/styles/fonts (${files.length} files)`);
} catch (error) {
    console.error(`fonts:  could not copy from ${FONT_DIR}`);
    console.error(`  ${error.message}`);
    process.exit(1);
}

// The Campaign's stylesheet, and the small set of shared rules it leans on (the
// (?) tooltips live in Common.css). Copied rather than rewritten, for the reason
// the tokens are: one history grid, drawn one way, in both windows. Fatal like
// the tokens — a grid without its styles is a column of unstyled spans.
const STYLES = [
    ["TrackProgress.css", "campaign.css"],
    ["Common.css", "common.css"]
];

STYLES.forEach(([file, name]) => {
    const from = join(here, "..", "..", "Styles", file);
    const to = join(here, "..", "src", "styles", name);

    try {
        const css = readFileSync(from, "utf8");
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, cssBanner(file) + css, "utf8");
        console.log(`styles: Styles/${file} -> src/styles/${name} (${css.length} bytes)`);
    } catch (error) {
        console.error(`styles: could not copy ${file}`);
        console.error(`  ${error.message}`);
        process.exit(1);
    }
});

function cssBanner(file) {
    return `/* GENERATED — do not edit.
 *
 * Copied from Styles/${file} at the repository root by
 * desktop/tools/sync-shared.mjs. Edit the source, not this.
 */

`;
}

// Artwork, for the same reason: one source, copied in, never edited here.
//
// Not fatal. The window drops an <img> that fails to load, and missing artwork
// is a cosmetic loss where missing tokens is an unreadable one.
const ART = [
    ["Golden crown and crossed swords emblem.png", "crest.png"],
    ["Medieval_Strategy.png", "strategy.png"],
    ["Fortress.png", "fortress.png"],
    ["Watchtower.png", "watchtower.png"],
    ["Seal.png", "seal.png"]
];

ART.forEach(([file, name]) => {
    const from = join(here, "..", "..", "Assets", file);
    const to = join(here, "..", "src", "assets", name);

    try {
        const png = readFileSync(from);
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, png);
        console.log(`art:    Assets/${file} -> src/assets/${name} (${png.length} bytes)`);
    } catch (error) {
        console.warn(`art:    ${file} skipped — ${error.message}`);
    }
});
