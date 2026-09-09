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

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
// Only the three the window actually uses. Stats.js and Seal.js are the
// extension's own storage and its seal prompt, and neither has any business
// running in here.
const SHARED = ["Tasks.js", "Categories.js", "Sync.js"];

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

// The crest, for the same reason: one source, copied in, never edited here.
const crestFrom = join(here, "..", "..", "Assets", "Golden crown and crossed swords emblem.png");
const crestTo = join(here, "..", "src", "assets", "crest.png");

try {
    const png = readFileSync(crestFrom);
    mkdirSync(dirname(crestTo), { recursive: true });
    writeFileSync(crestTo, png);
    console.log(`crest:  Assets/…emblem.png -> src/assets/crest.png (${png.length} bytes)`);
} catch (error) {
    // Not fatal. The window drops the <img> if it fails to load, and a missing
    // crest is a cosmetic loss where missing tokens is an unreadable one.
    console.warn(`crest:  skipped — ${error.message}`);
}
