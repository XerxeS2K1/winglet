#!/usr/bin/env python3
"""Fail if the web app bundled in plugin/web references a file that isn't shipped with it.

The plugin serves plugin/web as-is, so a missing font or script means a broken (often blank) app for
everyone who installs from GitHub.
"""
import hashlib
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ROOT = REPO / "plugin" / "web"
STAMP = ROOT / "source-stamp.txt"
# Everything the web build is made from. A change here means plugin/web must be rebuilt. app/public is copied into
# the bundle as it is (service worker, push guard, manifest); app.config.js, tsconfig.json, vendor/ and modules/ are
# read while it is built. app/plugins (Android prebuild only), tests and docs are not inputs; tests/test_web_bundle_gate.py
# fails when a new top-level entry in app/ is on neither list. A listed path that does not exist is skipped.
SOURCES = ("app/src", "app/assets", "app/public", "app/modules", "app/vendor", "app/app.json", "app/app.config.js",
           "app/package.json", "app/package-lock.json", "app/tsconfig.json")


def source_hash() -> str:
    digest = hashlib.sha256()
    for entry in SOURCES:
        base = REPO / entry
        files = sorted(base.rglob("*")) if base.is_dir() else [base]
        for path in files:
            if path.is_file() and "node_modules" not in path.parts:
                digest.update(path.relative_to(REPO).as_posix().encode())
                digest.update(path.read_bytes())
    return digest.hexdigest()


REF = re.compile(r"""["'(](/(?:assets|_expo/static|icons)/[^"'()\s?#]+)""")


def main() -> int:
    if "--stamp" in sys.argv:  # called by build-web.sh after copying the build
        STAMP.write_text(source_hash() + "\n")
        print(f"wrote {STAMP.relative_to(REPO)}")
        return 0
    if "--fresh" in sys.argv:  # release gate: the committed bundle must match the app source
        if not STAMP.is_file() or STAMP.read_text().strip() != source_hash():
            print("plugin/web is older than app/: run scripts/build-web.sh and commit plugin/web")
            return 1
        print("plugin/web matches the app source")
        return 0
    if not (ROOT / "index.html").is_file():
        print(f"missing {ROOT / 'index.html'}: run scripts/build-web.sh")
        return 1
    refs = set()
    for path in list(ROOT.rglob("*.js")) + list(ROOT.glob("*.html")) + list(ROOT.glob("*.webmanifest")):
        refs.update(REF.findall(path.read_text(encoding="utf-8", errors="ignore")))
    missing = sorted(r for r in refs if not (ROOT / r.lstrip("/")).is_file())
    for ref in missing:
        print(f"missing from plugin/web: {ref}")
    print(f"checked {len(refs)} asset references, {len(missing)} missing")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
