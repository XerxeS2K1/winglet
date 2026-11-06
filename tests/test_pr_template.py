"""The pull request template: the checklist that keeps docs, tests and the web bundle from being forgotten."""

from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TEMPLATE = REPO / ".github" / "pull_request_template.md"


def text():
    return TEMPLATE.read_text()


def test_the_template_exists_where_github_looks_for_it():
    assert TEMPLATE.is_file() and len(text().strip()) > 100


def test_it_is_a_checklist_of_tick_boxes():
    boxes = [line for line in text().splitlines() if line.startswith("- [ ] ")]
    assert 4 <= len(boxes) <= 10, boxes          # short enough that people read it


def test_it_asks_for_the_docs_to_be_updated_in_the_same_pull_request():
    body = text()
    assert "docs" in body.lower() and "same pull request" in body.lower()
    for name in ("README", "FEATURES", "BOTS", "DESIGN"):
        assert name in body, name
    for name in ("FEATURES", "BOTS", "DESIGN"):
        assert (REPO / "docs" / f"{name}.md").is_file(), name          # the checklist names files that exist


def test_it_asks_for_tests():
    body = text()
    assert "tests" in body.lower() and "pytest" in body and "npm test" in body


def test_it_covers_the_web_bundle_without_telling_feature_branches_to_rebuild_it():
    body = text()
    assert "plugin/web" in body and "build-web.sh" in body
    assert "release" in body.lower()                                     # the rebuild belongs to the release pull request


def test_it_has_a_release_section_for_the_promotion_pull_request():
    body = text()
    assert "docs/releases/v" in body and "banner" in body.lower() and "check_release_docs.py" in body


def test_it_asks_what_and_why():
    assert "What" in text() and "why" in text().lower()
