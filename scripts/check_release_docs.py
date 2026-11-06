#!/usr/bin/env python3
"""Refuse a release whose documents are missing or out of date.

Reads the version from plugin/plugin.yaml and app/app.json and fails unless

  * both files say the same x.y.z,
  * docs/releases/v<version>.md exists, has real content and starts with "# Winglet v<version>", and
  * the README's first "New in [v<version>](docs/releases/v<version>.md)" banner names that version.

With --tag (the release workflow passes the pushed tag) the tag is checked too: v1.2.3 or v1.2.3-beta.1 / -rc.1, with
the same x.y.z as the version files. A beta tag is documented by its own notes file and banner, because that is the file
the release workflow publishes (docs/releases/<tag>.md).

Every problem is printed with the file to fix; nothing is changed. Exit status 1 when anything is wrong.
"""
import argparse
import json
import re
import sys
from pathlib import Path

VERSION = re.compile(r"\d+\.\d+\.\d+")
TAG = re.compile(r"v(\d+\.\d+\.\d+)(-(?:beta|rc)\.\d+)?")
BANNER = re.compile(r"\*\*New in \[(v[^\]\s]*)\]\(([^)\s]*)\)")
MIN_NOTES_CHARS = 200  # a heading and a sentence are not release notes
_FENCE = re.compile(r" {0,3}(`{3,}|~{3,})")
_INLINE_CODE = re.compile(r"(`+)(?!`).+?(?<!`)\1(?!`)")


def visible_markdown(text: str) -> str:
    """The README as a reader sees it: without HTML comments, fenced code blocks and inline code.

    A banner that is only inside one of those is not on the page, so it must not stand in for the real one. An unclosed
    comment or fence hides the rest of the file, as it does on GitHub."""
    kept, fence, in_comment = [], None, False
    for line in text.splitlines():
        if fence:
            closing = re.fullmatch(r" {0,3}(" + re.escape(fence[0]) + "{" + str(len(fence)) + r",})\s*", line)
            if closing:
                fence = None
            continue
        if not in_comment:
            opening = _FENCE.match(line)
            if opening and not (opening.group(1)[0] == "`" and "`" in line[opening.end():]):
                fence = opening.group(1)
                continue
        out, rest = "", line
        while rest:
            if in_comment:
                end = rest.find("-->")
                if end < 0:
                    rest = ""
                else:
                    in_comment, rest = False, rest[end + 3:]
            else:
                start = rest.find("<!--")
                if start < 0:
                    out, rest = out + rest, ""
                else:
                    out, in_comment, rest = out + rest[:start], True, rest[start + 4:]
        kept.append(_INLINE_CODE.sub(" ", out))
    return "\n".join(kept)


def _read_versions(root: Path, problems: list):
    versions = {}
    try:
        text = (root / "plugin" / "plugin.yaml").read_text(encoding="utf-8")
        match = re.search(r"(?m)^version:\s*(\S*)\s*$", text)
        versions["plugin/plugin.yaml"] = match.group(1).strip("\"'") if match else None
    except OSError as exc:
        problems.append(f"plugin/plugin.yaml: cannot be read ({exc.strerror or exc}). It must contain 'version: x.y.z'.")
    try:
        data = json.loads((root / "app" / "app.json").read_text(encoding="utf-8"))
        versions["app/app.json"] = data["expo"]["version"]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        problems.append(f"app/app.json: cannot read expo.version ({type(exc).__name__}). It must contain {{\"expo\": {{\"version\": \"x.y.z\"}}}}.")
    for name, value in list(versions.items()):
        if not isinstance(value, str) or not VERSION.fullmatch(value):
            problems.append(f"{name}: the version is {value!r}, which is not a plain x.y.z like 0.10.5. Fix it there.")
            del versions[name]
    return versions


def check(root: Path, tag=None) -> tuple:
    """(problems, label): what is wrong, and the release name that was checked ('v1.2.3', or the tag)."""
    problems: list = []
    versions = _read_versions(root, problems)
    if len(set(versions.values())) > 1:
        shown = ", ".join(f"{name} says {value}" for name, value in sorted(versions.items()))
        problems.append(f"The version files disagree: {shown}. Make them the same (plugin/hub.py VERSION and app/package.json too).")
    base = next(iter(versions.values()), None)
    label = f"v{base}" if base else None
    if tag is not None:
        match = TAG.fullmatch(tag)
        if not match:
            problems.append(f"The tag {tag!r} is not a release tag: it must look like v1.2.3 or v1.2.3-beta.1.")
            label = None
        else:
            label = tag
            if base and match.group(1) != base:
                problems.append(f"The tag {tag} does not match the version files, which say {base}. Bump the version first, or tag v{base}.")
    if label is None:
        return problems, None
    notes_path = f"docs/releases/{label}.md"
    notes = root / notes_path
    if not notes.is_file():
        problems.append(f"{notes_path} does not exist. Write the release notes (copy the layout of the last file in docs/releases/); "
                        f"its first line must be '# Winglet {label}'.")
    else:
        text = notes.read_text(encoding="utf-8", errors="replace")
        first = next((line.strip() for line in text.splitlines() if line.strip()), "")
        if first != f"# Winglet {label}":
            problems.append(f"{notes_path}: the first line is {first[:60]!r}, but it must be '# Winglet {label}'. "
                            f"Was this file copied from an earlier release and not updated?")
        if len(text.strip()) < MIN_NOTES_CHARS:
            problems.append(f"{notes_path} is too short to be release notes ({len(text.strip())} characters). Say what changed, in plain words.")
    try:
        readme = (root / "README.md").read_text(encoding="utf-8", errors="replace")
    except OSError:
        problems.append("README.md cannot be read. It needs the banner '> **New in [%s](docs/releases/%s.md):** ...'." % (label, label))
        return problems, label
    banner = BANNER.search(visible_markdown(readme))
    if not banner:
        problems.append(f"README.md has no 'New in [{label}]' banner. Add '> **New in [{label}](docs/releases/{label}.md):** ...' "
                        f"near the top, in place of the previous one.")
    elif banner.group(1) != label:
        problems.append(f"README.md: the 'New in' banner names {banner.group(1)}, but this release is {label}. Update the banner.")
    elif banner.group(2) != notes_path:
        problems.append(f"README.md: the 'New in [{label}]' banner links to {banner.group(2)}, but it must link to {notes_path}.")
    return problems, label


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n")[0])
    parser.add_argument("--tag", help="the pushed tag, e.g. v0.10.5 or v0.10.5-beta.1")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    problems, label = check(args.root, args.tag)
    for problem in problems:
        print(f"FAIL: {problem}")
    if problems:
        print(f"\nThe release documents are not ready ({len(problems)} problem{'s' if len(problems) != 1 else ''}). Nothing was changed.")
        return 1
    print(f"Release documents are in place for {label}: docs/releases/{label}.md and the README banner.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
