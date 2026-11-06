"""docs/RELEASING.md describes the flow the repository really has: release from main, via a pull request from integration/dev-all."""

import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DOC = (REPO / "docs" / "RELEASING.md").read_text()


def section(title):
    match = re.search(rf"(?ms)^## {re.escape(title)}\n(.*?)(?=^## |\Z)", DOC)
    assert match, f"no section called {title!r}"
    return match.group(1)


def test_the_steps_come_in_the_order_that_keeps_the_bundle_and_the_docs_fresh():
    body = section("Cutting a release")
    phrases = ["Set the same version", "docs/releases/v<version>.md", "./scripts/build-web.sh", "commit `plugin/web`",
               "pull request from `integration/dev-all` to `main`", "git switch main", "git tag v", "git push origin v"]
    positions = [body.lower().find(p.lower()) for p in phrases]
    assert all(p >= 0 for p in positions), dict(zip(phrases, positions))
    assert positions == sorted(positions), dict(zip(phrases, positions))          # bump, notes, rebuild, commit, PR, tag main, push


def test_the_release_is_tagged_on_main_not_on_the_working_branch():
    body = section("Cutting a release")
    assert "git switch main" in body and "git pull" in body
    assert body.index("git switch main") < body.index("git tag v")
    assert "git tag" not in body.split("git switch main")[0]


def test_it_names_every_file_that_carries_the_version():
    body = section("Cutting a release")
    for name in ("plugin/plugin.yaml", "plugin/hub.py", "app/app.json", "app/package.json"):
        assert name in body, name


def test_it_explains_the_documents_check_and_what_it_looks_at():
    body = section("Cutting a release")
    assert "scripts/check_release_docs.py" in body and "README" in body and "banner" in body.lower()
    assert "# Winglet v<version>" in body


def test_it_says_when_the_web_app_is_rebuilt_and_why_once():
    body = section("Cutting a release")
    assert "after the bump" in body and "once" in body and "conflict" in body


def test_it_says_the_pull_request_runs_the_release_checks_without_publishing():
    body = section("Cutting a release")
    assert "validation" in body.lower() and "without publishing" in body and "signing key" in body


def test_feature_pull_requests_are_told_to_update_their_docs():
    assert "pull request template" in section("Cutting a release")


def test_betas_and_release_notes_say_the_notes_are_required():
    assert "v0.2.0-beta.1.md" in section("Cutting a release") + DOC
    notes = DOC[DOC.index("### Release notes"):]
    assert "required" in notes and "refuses" in notes


def test_the_parts_that_did_not_change_are_still_there():
    for needle in ("## One-time setup: your signing key", "ANDROID_KEYSTORE_BASE64", "48be2677740ba3ba5c2b93e0195906ebdcc3b7525cb32acbf86090807fa279ae",
                   "### Betas", "versionCode", "Manual runs from the Actions tab"):
        assert needle in DOC, needle


def test_it_no_longer_tells_anyone_to_tag_before_the_pull_request_merges():
    assert "Before tagging, set the same version" not in DOC


def test_the_doc_only_promises_what_the_workflow_checks():
    """The doc says a tag outside main publishes nothing; that must be a check the workflow really makes."""
    body = section("Cutting a release")
    assert "refuses a tag whose commit is not on `main`" in body
    assert "Nothing is published from any other branch." not in body                  # the old, unchecked promise
    workflow = (REPO / ".github" / "workflows" / "release.yml").read_text()
    assert "git merge-base --is-ancestor \"$GITHUB_SHA\" refs/remotes/origin/main" in workflow
