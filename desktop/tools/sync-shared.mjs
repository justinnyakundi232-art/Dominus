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
