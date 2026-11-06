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
WATCHED = ["app/src/app/index.tsx", "app/assets/icon.png", "app/app.json", "app/package.json", "app/package-lock.json"]


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


def test_the_release_workflow_runs_the_gate_and_the_build_script_stamps():
    workflow = (REPO / ".github" / "workflows" / "release.yml").read_text()
    assert "scripts/check_web_bundle.py --fresh" in workflow
    assert "--stamp" in (REPO / "scripts" / "build-web.sh").read_text()
