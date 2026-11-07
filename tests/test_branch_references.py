"""After the move to main: what users install, and where contributors send changes, says main (or the real working branch).

Work lands on integration/dev-all; a release is a pull request from there to main and the tag goes on main. So what is
documented for users and what the weekly Hermes check tests is main; contributors' branches start from dev-all.
"""

import re
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent


def workflow(name):
    return yaml.safe_load((REPO / ".github" / "workflows" / name).read_text())


def test_the_weekly_hermes_check_tests_what_users_install():
    """Users install main, so main is what the weekly check against Hermes's newest code must test."""
    flow = workflow("hermes-main.yml")
    inputs = (flow.get(True) or flow.get("on"))["workflow_dispatch"]["inputs"]
    assert inputs["plugin_ref"]["default"] == "main" and "main" in inputs["plugin_ref"]["description"]
    checkout = flow["jobs"]["hermes-main"]["steps"][0]
    assert checkout["with"]["ref"] == "${{ inputs.plugin_ref || 'main' }}"


def test_the_weekly_check_comment_matches_what_it_does():
    text = (REPO / ".github" / "workflows" / "hermes-main.yml").read_text()
    assert "integration/dev-all" not in text
    assert "it checks out and tests main explicitly" in text


def test_the_remote_access_guide_link_points_at_main():
    source = (REPO / "plugin" / "cli.py").read_text()
    assert "blob/main/docs/REMOTE_ACCESS.md" in source and "integration/dev-all" not in source
    assert (REPO / "docs" / "REMOTE_ACCESS.md").is_file()


def test_the_compatibility_page_describes_what_the_ci_pin_really_runs():
    text = (REPO / "docs" / "HERMES_COMPATIBILITY.md").read_text()
    ci = workflow("ci.yml")
    triggers = ci.get(True) or ci.get("on")
    assert triggers["push"]["branches"] == ["main", "integration/dev-all"] and "pull_request" in triggers     # what the page now says
    row = next(line for line in text.splitlines() if line.startswith("| **v0.23.0**"))
    assert "every push to `main` and `integration/dev-all`, and on every pull request" in row
    assert "every push to `integration/dev-all`." not in row


def test_contributors_are_told_where_to_branch_from_and_where_to_send_pull_requests():
    text = (REPO / "CONTRIBUTING.md").read_text()
    assert "integration/dev-all" in text and "branch from `main`" not in text
    assert "same pull request" in text and "docs" in text.lower()      # the docs rule from the release flow
    assert "main" in text                                              # and what main is


def test_no_document_still_tells_people_to_install_from_the_integration_branch():
    offenders = []
    for path in [REPO / "README.md", REPO / "CONTRIBUTING.md", *sorted((REPO / "docs").glob("*.md"))]:
        for number, line in enumerate(path.read_text().splitlines(), 1):
            if re.search(r"(plugins? (install|update)\b.*integration/dev-all|git clone .*integration/dev-all|(blob|tree|raw)/integration/dev-all"
                         r"|--ref[ =]integration/dev-all|-b integration/dev-all|install from integration/dev-all)", line):
                offenders.append(f"{path.relative_to(REPO)}:{number}")
    assert offenders == []
