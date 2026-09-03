#!/usr/bin/env python3
"""build.py — package Dominus for the Chrome Web Store.

    python build.py            # build dist/Dominus-<version>.zip
    python build.py --list     # show what would ship, and what wouldn't

Standard library only, like everything else here.

Design note — an allowlist, derived rather than written down
------------------------------------------------------------
The obvious way to do this is a list of things to leave out: not Tests/, not
docs/, not .git/. That list is wrong the moment someone adds a directory and
forgets to update it, and the failure is silent — a private note or a scratch
file ships to every user and nobody notices.

So this works the other way round. It starts at manifest.json and follows
references: the manifest names the service worker, the popup and the icons;
each HTML page names its scripts, stylesheets and images; each stylesheet names
whatever it url()s; the service worker names what it importScripts. Whatever is
reachable that way is the extension. Everything else is, by definition, not.

A new development file is therefore excluded by default rather than by
remembering — and the reverse is checked too: anything present but unreachable
is reported, which is how Assets/Key.png was found sitting unused in the tree.
"""

import argparse
import json
import os
import re
import sys
import zipfile
from urllib.parse import unquote

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, "dist")

# Anything matching these is a reference to somewhere else, not to a file here.
EXTERNAL = re.compile(r"^(https?:|data:|mailto:|#|//)")

# Where references hide, per file type.
HTML_REF = re.compile(r"""(?:src|href)\s*=\s*["']([^"']+)["']""", re.I)
CSS_REF = re.compile(r"""url\(\s*["']?([^"')]+)["']?\s*\)""", re.I)
IMPORT_SCRIPTS = re.compile(r"importScripts\s*\(([^)]*)\)", re.I)
JS_STRING = re.compile(r"""["']([^"']+\.(?:js|css|html|png|jpg|jpeg|svg|webp))["']""", re.I)


def norm(ref):
    """A reference as a repo-relative path, or None if it points off-site."""
    ref = ref.strip()
    if not ref or EXTERNAL.match(ref):
        return None
    # Strip a query or fragment — App.html#/keep is still App.html.
    ref = ref.split("#")[0].split("?")[0]
    if not ref:
        return None
    return unquote(ref).replace("\\", "/").lstrip("./")


def refs_in(path):
    """Every repo-relative file this file points at."""
    ext = os.path.splitext(path)[1].lower()
    try:
        text = open(os.path.join(ROOT, path), encoding="utf-8", errors="replace").read()
    except OSError:
        return []

    found = []

    if ext == ".html":
        found += HTML_REF.findall(text)
    elif ext == ".css":
        found += CSS_REF.findall(text)
    elif ext == ".js":
        # The service worker's importScripts is the only place a JS file names
        # another one. Any other string that happens to look like a filename is
        # picked up too, which errs toward shipping something unnecessary rather
        # than leaving something out.
        for call in IMPORT_SCRIPTS.findall(text):
            found += re.findall(r"""["']([^"']+)["']""", call)
        found += JS_STRING.findall(text)

    out = []
    for ref in found:
        p = norm(ref)
        if p:
            out.append(p)
    return out


def manifest_refs(manifest):
    """Every file the manifest itself names, wherever it names one."""
    found = []

    def walk(node):
        if isinstance(node, dict):
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
        elif isinstance(node, str):
            p = norm(node)
            if p and os.path.isfile(os.path.join(ROOT, p)):
                found.append(p)

    walk(manifest)
    return found


def collect():
    """Everything reachable from manifest.json. Returns (shipping, missing)."""
    manifest = json.load(open(os.path.join(ROOT, "manifest.json"), encoding="utf-8"))

    shipping = {"manifest.json"}
    missing = []
    queue = list(manifest_refs(manifest))

    while queue:
        path = queue.pop()
        if path in shipping:
            continue
        if not os.path.isfile(os.path.join(ROOT, path)):
            missing.append(path)
            continue
        shipping.add(path)
        queue.extend(refs_in(path))

    return sorted(shipping), sorted(set(missing))


def everything_present():
    """Every file in the tree, minus the places nothing shippable ever lives."""
    skip_dirs = {".git", "__pycache__", "node_modules"}
    out = []
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        for name in files:
            rel = os.path.relpath(os.path.join(base, name), ROOT).replace("\\", "/")
            out.append(rel)
    return sorted(out)


def changelog_version():
    """The version at the top of the changelog, for cross-checking."""
    try:
        text = open(os.path.join(ROOT, "CHANGELOG.md"), encoding="utf-8").read()
    except OSError:
        return None
    m = re.search(r"^##\s*\[([^\]]+)\]", text, re.M)
    return m.group(1) if m else None


def main():
    parser = argparse.ArgumentParser(description="Package Dominus for the Web Store.")
    parser.add_argument("--list", action="store_true",
                        help="show what would ship and what would not, without building")
    args = parser.parse_args()

    manifest = json.load(open(os.path.join(ROOT, "manifest.json"), encoding="utf-8"))
    version = manifest["version"]

    shipping, missing = collect()
    excluded = [p for p in everything_present() if p not in shipping]

    print(f"Dominus {version}\n")

    if missing:
        print("MISSING — referenced but not on disk:")
        for p in missing:
            print(f"  {p}")
        print("\nRefusing to build a package with broken references.")
        return 1

    total = sum(os.path.getsize(os.path.join(ROOT, p)) for p in shipping)
    print(f"Shipping {len(shipping)} files, {total / 1024:.0f} KB:")
    for p in shipping:
        size = os.path.getsize(os.path.join(ROOT, p))
        print(f"  {size / 1024:8.1f} KB  {p}")

    # Anything in Assets that nothing references is dead weight every user
    # downloads. Worth naming rather than quietly leaving out.
    orphan_assets = [p for p in excluded if p.startswith("Assets/")]
    if orphan_assets:
        print("\nUNREFERENCED ASSETS — in the tree, used by nothing:")
        for p in orphan_assets:
            print(f"  {os.path.getsize(os.path.join(ROOT, p)) / 1024:8.1f} KB  {p}")

    if args.list:
        print(f"\nExcluded ({len(excluded)} files):")
        for p in excluded:
            print(f"  {p}")
        return 0

    changelog = changelog_version()
    if changelog and changelog != version:
        print(f"\nNote: manifest says {version}, the changelog's newest entry is {changelog}.")

    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, f"Dominus-{version}.zip")

    # Deterministic: sorted order and a fixed timestamp, so rebuilding the same
    # source twice produces the same bytes and a diff means something changed.
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in shipping:
            info = zipfile.ZipInfo(p, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, open(os.path.join(ROOT, p), "rb").read())

    print(f"\nBuilt {os.path.relpath(out, ROOT)} — {os.path.getsize(out) / 1024:.0f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
