"""The release docs gate: a version may only be released when its release notes and the README banner are there.

scripts/check_release_docs.py reads the version from plugin/plugin.yaml and app/app.json and fails, naming the file to fix,
unless docs/releases/v<version>.md exists and starts with "# Winglet v<version>", and the README's "New in [v<version>]"
banner names that version and links to that file. On a tag push it also checks the tag itself (v1.2.3 or v1.2.3-beta.1).
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "scripts" / "check_release_docs.py"


def make_tree(root: Path, *, version="1.2.3", plugin_version=None, app_version=None, notes="default", banner="default",
              notes_name=None, newline="\n"):
    (root / "plugin").mkdir(parents=True, exist_ok=True)
    (root / "app").mkdir(exist_ok=True)
    (root / "docs" / "releases").mkdir(parents=True, exist_ok=True)
    (root / "plugin" / "plugin.yaml").write_text(f"name: winglet\nversion: {plugin_version or version}\nrequires_hermes: \">=0.22.7\"\n")
    (root / "app" / "app.json").write_text(json.dumps({"expo": {"name": "Winglet", "version": app_version or version}}))
    if banner == "default":
        banner = f"> [!TIP]\n> **New in [v{version}](docs/releases/v{version}.md):** something good.\n"
    (root / "README.md").write_text(f"# Winglet\n\nIntro.\n\n{banner}\n## Why\n".replace("\n", newline), newline="")
    if notes == "default":
        notes = f"# Winglet v{version}\n\nWhat changed, in plain words. " + "x" * 200 + "\n"
    if notes is not None:
        (root / "docs" / "releases" / (notes_name or f"v{version}.md")).write_text(notes)
    return root


def run(root, *args):
    result = subprocess.run([sys.executable, str(SCRIPT), "--root", str(root), *args], capture_output=True, text=True)
    return result.returncode, result.stdout + result.stderr


# -- a release that is documented ---------------------------------------------------------------------------------------


def test_a_documented_version_passes(tmp_path):
    code, out = run(make_tree(tmp_path))
    assert code == 0 and "1.2.3" in out and "FAIL" not in out


def test_the_repository_itself_passes_today():
    """main must always be releasable as far as the docs go: this fails the day someone bumps a version and forgets them."""
    result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True, cwd=REPO)
    assert result.returncode == 0, result.stdout


def test_windows_line_endings_are_fine(tmp_path):
    code, out = run(make_tree(tmp_path, newline="\r\n"))
    assert code == 0, out


# -- what is missing, and what the message says ---------------------------------------------------------------------------


def test_missing_release_notes_fail_and_name_the_file_to_write(tmp_path):
    code, out = run(make_tree(tmp_path, notes=None))
    assert code == 1
    assert "docs/releases/v1.2.3.md" in out and "does not exist" in out and "FAIL" in out


@pytest.mark.parametrize("notes", ["", "   \n\n", "# Winglet v1.2.3\n"])
def test_empty_or_heading_only_release_notes_fail(tmp_path, notes):
    code, out = run(make_tree(tmp_path, notes=notes))
    assert code == 1 and "docs/releases/v1.2.3.md" in out


def test_release_notes_copied_from_the_last_release_fail(tmp_path):
    code, out = run(make_tree(tmp_path, notes="# Winglet v1.2.2\n\n" + "old words " * 40))
    assert code == 1
    assert "docs/releases/v1.2.3.md" in out and "# Winglet v1.2.3" in out        # says exactly what the first line must be


def test_release_notes_for_another_version_do_not_count(tmp_path):
    code, out = run(make_tree(tmp_path, notes=None, notes_name="v1.2.2.md"))
    assert code == 1 and "v1.2.3.md" in out


def test_a_readme_without_the_banner_fails(tmp_path):
    code, out = run(make_tree(tmp_path, banner="> Some other note.\n"))
    assert code == 1 and "README.md" in out and "New in [v1.2.3]" in out


def test_a_banner_that_names_the_old_version_fails_and_says_both(tmp_path):
    code, out = run(make_tree(tmp_path, banner="> **New in [v1.2.2](docs/releases/v1.2.2.md):** old news.\n"))
    assert code == 1 and "README.md" in out and "v1.2.2" in out and "v1.2.3" in out


def test_the_banner_must_link_to_the_notes_of_that_version(tmp_path):
    code, out = run(make_tree(tmp_path, banner="> **New in [v1.2.3](docs/releases/v1.2.2.md):** wrong link.\n"))
    assert code == 1 and "docs/releases/v1.2.3.md" in out


def test_only_the_first_banner_counts(tmp_path):
    banner = ("> **New in [v1.2.2](docs/releases/v1.2.2.md):** old.\n\n"
              "> **New in [v1.2.3](docs/releases/v1.2.3.md):** new, but further down.\n")
    code, out = run(make_tree(tmp_path, banner=banner))
    assert code == 1 and "README.md" in out


def test_every_problem_is_reported_at_once(tmp_path):
    code, out = run(make_tree(tmp_path, notes=None, banner="> nothing\n"))
    assert code == 1 and "docs/releases/v1.2.3.md" in out and "README.md" in out and out.count("FAIL") >= 2


# -- the version itself ---------------------------------------------------------------------------------------------------------


def test_the_two_version_files_must_agree(tmp_path):
    code, out = run(make_tree(tmp_path, plugin_version="1.2.3", app_version="1.2.4"))
    assert code == 1 and "plugin/plugin.yaml" in out and "app/app.json" in out and "1.2.3" in out and "1.2.4" in out


@pytest.mark.parametrize("bad", ["1.2", "v1.2.3", "latest", "1.2.3.4", ""])
def test_a_version_that_is_not_x_y_z_fails_clearly(tmp_path, bad):
    root = make_tree(tmp_path)
    (root / "plugin" / "plugin.yaml").write_text(f"name: winglet\nversion: {bad}\n")
    code, out = run(root)
    assert code == 1 and "plugin/plugin.yaml" in out and "Traceback" not in out


def test_an_unreadable_version_file_fails_without_a_traceback(tmp_path):
    root = make_tree(tmp_path)
    (root / "app" / "app.json").write_text("{broken")
    code, out = run(root)
    assert code == 1 and "app/app.json" in out and "Traceback" not in out
    (root / "app" / "app.json").unlink()
    code, out = run(root)
    assert code == 1 and "app/app.json" in out and "Traceback" not in out


# -- on a tag push -----------------------------------------------------------------------------------------------------------------


def test_the_tag_must_be_the_version(tmp_path):
    root = make_tree(tmp_path)
    assert run(root, "--tag", "v1.2.3")[0] == 0
    code, out = run(root, "--tag", "v1.2.4")
    assert code == 1 and "v1.2.4" in out and "1.2.3" in out


@pytest.mark.parametrize("tag", ["1.2.3", "v1.2", "v1.2.3.4", "release-1", "v1.2.3-alpha.1", "v1.2.3-beta", "v1.2.3 ", ""])
def test_a_tag_of_the_wrong_shape_fails(tmp_path, tag):
    code, out = run(make_tree(tmp_path), "--tag", tag)
    assert code == 1 and "tag" in out.lower()


def test_a_beta_tag_needs_its_own_notes_and_banner(tmp_path):
    root = make_tree(tmp_path, notes=None)
    (root / "docs" / "releases" / "v1.2.3-beta.1.md").write_text("# Winglet v1.2.3-beta.1\n\n" + "words " * 60)
    (root / "README.md").write_text("# W\n\n> **New in [v1.2.3-beta.1](docs/releases/v1.2.3-beta.1.md):** a beta.\n")
    assert run(root, "--tag", "v1.2.3-beta.1")[0] == 0
    (root / "README.md").write_text("# W\n\n> **New in [v1.2.3](docs/releases/v1.2.3.md):** the final.\n")
    code, out = run(root, "--tag", "v1.2.3-beta.1")
    assert code == 1 and "README.md" in out and "v1.2.3-beta.1" in out


def test_a_beta_tag_for_another_base_version_fails(tmp_path):
    code, out = run(make_tree(tmp_path), "--tag", "v1.3.0-beta.1")
    assert code == 1 and "1.2.3" in out


def test_the_script_never_modifies_anything(tmp_path):
    root = make_tree(tmp_path, notes=None)
    before = {p: p.read_bytes() for p in root.rglob("*") if p.is_file()}
    run(root)
    assert {p: p.read_bytes() for p in root.rglob("*") if p.is_file()} == before


# -- the checks fail for their own reason, not because something else is missing ----------------------------------------------


def documented(root, label, *, banner_label=None):
    """Notes and a banner for a release label, so that nothing but the check under test can fail."""
    banner_label = banner_label or label
    (root / "docs" / "releases").mkdir(parents=True, exist_ok=True)
    (root / "docs" / "releases" / f"{label}.md").write_text(f"# Winglet {label}\n\nWhat changed, in plain words. " + "x" * 200 + "\n")
    return f"> **New in [{banner_label}](docs/releases/{banner_label}.md):** something good.\n"


@pytest.mark.parametrize("version", ["1.2.3.4", "1.2.3-beta.1", "1.2.3rc1", "1.2.3 beta", "1.2.", "1.2.3+build", "v1.2.3", "1.02.3x"])
def test_a_version_that_is_not_exactly_x_y_z_is_refused_even_when_its_documents_exist(tmp_path, version):
    """The notes and the banner exist for this very label, so only the version check can refuse it."""
    root = make_tree(tmp_path, notes=None, banner="> placeholder\n")
    (root / "plugin" / "plugin.yaml").write_text(f"name: winglet\nversion: '{version}'\n")
    (root / "app" / "app.json").write_text(json.dumps({"expo": {"version": version}}))
    label = f"v{version}"
    (root / "README.md").write_text("# Winglet\n\n" + documented(root, label))
    code, out = run(root)
    assert code == 1, out
    assert "not a plain x.y.z" in out and "plugin/plugin.yaml" in out and "app/app.json" in out


def test_an_exact_version_with_its_documents_passes(tmp_path):
    root = make_tree(tmp_path, notes=None, banner="> placeholder\n")
    (root / "README.md").write_text("# Winglet\n\n" + documented(root, "v1.2.3"))
    assert run(root)[0] == 0


@pytest.mark.parametrize("tag", ["v1.2.4", "v1.3.0", "v2.0.0", "v1.2.4-beta.1", "v0.2.3"])
def test_a_tag_that_is_not_the_version_is_refused_even_when_its_own_documents_exist(tmp_path, tag):
    """Notes and banner exist for the tag AND for the version in the files, so only the explicit comparison can refuse."""
    root = make_tree(tmp_path)                                         # complete documents for v1.2.3
    (root / "README.md").write_text("# Winglet\n\n" + documented(root, tag))   # ...and for the tag, which the banner names
    code, out = run(root, "--tag", tag)
    assert code == 1, out
    assert f"The tag {tag} does not match the version files" in out and "1.2.3" in out
    assert out.count("FAIL") == 1                                      # nothing else is wrong: this is the only reason


def test_the_tag_that_is_the_version_passes_when_documented(tmp_path):
    root = make_tree(tmp_path, notes=None, banner="> placeholder\n")
    (root / "README.md").write_text("# Winglet\n\n" + documented(root, "v1.2.3-beta.1"))
    assert run(root, "--tag", "v1.2.3-beta.1")[0] == 0
