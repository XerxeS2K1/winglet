"""The release gate that stops a tag when plugin/web is older than the app source it should have been built from.

`hermes plugins install` serves plugin/web straight from git, so a stale bundle ships a stale web app. The gate
(scripts/check_web_bundle.py --stamp / --fresh) records a hash of the app source when the bundle is built and
compares it at release time. These tests run a copy of the real script inside a throwaway repo layout.
"""

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "scripts" / "check_web_bundle.py"

# Every input the gate claims to watch, with a file that exists in the throwaway repo.
WATCHED = ["app/src/app/index.tsx", "app/assets/icon.png", "app/app.json", "app/package.json", "app/package-lock.json",
           # copied into the bundle as they are, or read while it is built:
           "app/public/sw.js", "app/app.config.js", "app/vendor/decode-uri-component/index.js",
           "app/modules/winglet-push/index.ts", "app/tsconfig.json"]


@pytest.fixture
def tree(tmp_path):
    """A tiny repo: app source, a built bundle that references one real file, and a copy of the script."""
    (tmp_path / "scripts").mkdir()
    shutil.copy(SCRIPT, tmp_path / "scripts" / SCRIPT.name)
    for rel in WATCHED:
        path = tmp_path / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(f"original {rel}".encode())
    web = tmp_path / "plugin" / "web"
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text('<script src="/assets/app.js"></script>')
    (web / "assets" / "app.js").write_text("console.log(1)")
    return tmp_path


def run(tree: Path, *flags: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(tree / "scripts" / SCRIPT.name), *flags],
                          capture_output=True, text=True, timeout=60)


def stamp(tree: Path) -> str:
    done = run(tree, "--stamp")
    assert done.returncode == 0, done.stdout + done.stderr
    return (tree / "plugin" / "web" / "source-stamp.txt").read_text().strip()


def test_matching_stamp_passes(tree):
    value = stamp(tree)
    assert len(value) == 64 and set(value) <= set("0123456789abcdef")
    done = run(tree, "--fresh")
    assert done.returncode == 0, done.stdout + done.stderr
    assert "matches" in done.stdout


def test_missing_stamp_fails(tree):
    done = run(tree, "--fresh")
    assert done.returncode == 1
    assert "build-web.sh" in done.stdout  # tells the releaser what to do


@pytest.mark.parametrize("rel", WATCHED)
def test_stale_stamp_fails_when_any_watched_input_changes(tree, rel):
    stamp(tree)
    assert run(tree, "--fresh").returncode == 0
    (tree / rel).write_bytes(b"changed after the bundle was built")
    done = run(tree, "--fresh")
    assert done.returncode == 1, f"changing {rel} did not make the bundle stale"
    assert "older than app/" in done.stdout


def test_new_and_removed_source_files_make_the_bundle_stale(tree):
    stamp(tree)
    added = tree / "app" / "src" / "lib" / "new.ts"
    added.parent.mkdir(parents=True)
    added.write_text("export const x = 1;")
    assert run(tree, "--fresh").returncode == 1
    added.unlink()
    assert run(tree, "--fresh").returncode == 0  # back to what was built
    (tree / "app" / "src" / "app" / "index.tsx").unlink()
    assert run(tree, "--fresh").returncode == 1


def test_renaming_a_source_file_makes_the_bundle_stale(tree):
    stamp(tree)
    old = tree / "app" / "src" / "app" / "index.tsx"
    old.rename(old.with_name("home.tsx"))  # same bytes, different name
    assert run(tree, "--fresh").returncode == 1


def test_garbage_or_empty_stamp_fails(tree):
    stamp_file = tree / "plugin" / "web" / "source-stamp.txt"
    for text in ["", "\n", "not a hash\n", "0" * 64 + "\n"]:
        stamp_file.write_text(text)
        assert run(tree, "--fresh").returncode == 1, repr(text)


def test_node_modules_inside_the_app_do_not_count(tree):
    stamp(tree)
    junk = tree / "app" / "src" / "node_modules" / "pkg" / "index.js"
    junk.parent.mkdir(parents=True)
    junk.write_text("local install noise")
    assert run(tree, "--fresh").returncode == 0


def test_restamping_after_a_rebuild_makes_it_fresh_again(tree):
    stamp(tree)
    (tree / "app" / "app.json").write_bytes(b"version bump")
    assert run(tree, "--fresh").returncode == 1
    stamp(tree)
    assert run(tree, "--fresh").returncode == 0


def test_the_plain_check_still_finds_a_missing_bundle_file(tree):
    assert run(tree).returncode == 0
    (tree / "plugin" / "web" / "assets" / "app.js").unlink()
    done = run(tree)
    assert done.returncode == 1
    assert "/assets/app.js" in done.stdout


def gate_module():
    import importlib.util
    spec = importlib.util.spec_from_file_location("check_web_bundle_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# What lives in app/ and does NOT go into the web build, with the reason. Anything else in app/ must be watched, so a
# new folder cannot quietly become a build input the gate does not see (public/ and the config files did exactly that).
NOT_WEB_INPUTS = {
    "README.md": "documentation",
    "tests": "unit tests",
    "scripts": "helper scripts (make_sounds.py), not part of the build",
    "plugins": "Expo config plugins: they only run for the Android prebuild, never for the web export",
    "node_modules": "installed dependencies, pinned by package-lock.json",
}


def tracked_app_entries():
    """Top-level names git tracks in app/. Local leftovers (node_modules, dist, .expo) are not the repository's business."""
    listing = subprocess.run(["git", "ls-files", "-z", "app"], cwd=REPO, capture_output=True, text=True)
    if listing.returncode != 0:
        pytest.skip("not a git checkout")
    return {path.split("/")[1] for path in listing.stdout.split("\0") if path.count("/") >= 1}


def test_every_entry_in_app_is_either_watched_or_named_as_not_a_web_input():
    sources = {entry.split("/", 1)[1] for entry in gate_module().SOURCES if entry.startswith("app/")}
    present = tracked_app_entries()
    unaccounted = present - sources - set(NOT_WEB_INPUTS)
    assert not unaccounted, f"app/ tracks {sorted(unaccounted)}: add to SOURCES in check_web_bundle.py, or to NOT_WEB_INPUTS here with a reason"
    # the other way round: a name on the not-an-input list that is no longer tracked is a stale entry
    assert not (set(NOT_WEB_INPUTS) - {"node_modules"}) - present, "NOT_WEB_INPUTS names something that is gone"
    # the check can fail: a new folder would be caught
    assert {"brand_new_folder"} - sources - set(NOT_WEB_INPUTS)


def test_the_real_gate_watches_the_inputs_that_were_missed_before():
    sources = gate_module().SOURCES
    for entry in ("app/public", "app/app.config.js", "app/vendor", "app/modules", "app/tsconfig.json",
                  "app/src", "app/assets", "app/app.json", "app/package.json", "app/package-lock.json"):
        assert entry in sources, entry
        assert (REPO / entry).exists(), f"{entry} is listed but does not exist in the repository"


def test_a_watched_input_that_does_not_exist_is_skipped_not_an_error(tree):
    shutil.rmtree(tree / "app" / "vendor")
    stamp(tree)
    assert run(tree, "--fresh").returncode == 0


def test_the_release_workflow_runs_the_gate_only_for_tag_pushes_and_the_build_script_stamps():
    import yaml
    workflow = yaml.safe_load((REPO / ".github" / "workflows" / "release.yml").read_text())
    steps = [s for s in workflow["jobs"]["checks"]["steps"] if "scripts/check_web_bundle.py --fresh" in str(s.get("run", ""))]
    assert len(steps) == 1
    # The tag is what publishes. Pull requests and manual runs only validate, so they must not need a rebuilt bundle.
    assert steps[0].get("if") == "startsWith(github.ref, 'refs/tags/v')"
    plain = [s for s in workflow["jobs"]["checks"]["steps"] if str(s.get("run", "")).strip() == "python scripts/check_web_bundle.py"]
    assert len(plain) == 1 and "if" not in plain[0]      # the cheap completeness check still runs everywhere
    assert "--stamp" in (REPO / "scripts" / "build-web.sh").read_text()


def test_the_release_notes_for_maintainers_put_the_rebuild_after_the_version_bump():
    text = (REPO / "docs" / "RELEASING.md").read_text()
    section = text[text.index("## Before tagging: rebuild the web app"):]
    section = section[:section.index("\n## ", 5)]
    steps = ("1. Bump the version files", "2. Run `./scripts/build-web.sh`", "3. Commit `plugin/web`", "4. Check it:", "5. Tag.")
    positions = [section.find(step) for step in steps]
    assert all(p >= 0 for p in positions) and positions == sorted(positions), (steps, positions)
    assert "--fresh" in section                           # how to check before tagging
    assert "final merge" in section                       # rebuild once, after the last merge, not per branch
