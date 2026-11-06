"""The release workflow runs the docs gate where it matters: on tag pushes, and on pull requests that target main.

A tag push is the release itself, so there the tag is checked as well (--tag). A pull request to main is the last chance to
catch missing release notes before the tag, so there the gate checks the version files. A manual run builds test artifacts
and publishes nothing, so it does not need them.
"""

from pathlib import Path

import pytest
import yaml

WORKFLOW = Path(__file__).resolve().parent.parent / ".github" / "workflows" / "release.yml"


@pytest.fixture(scope="module")
def workflow():
    return yaml.safe_load(WORKFLOW.read_text())


def steps_running(job, text):
    return [step for step in job["steps"] if text in str(step.get("run", ""))]


def test_the_workflow_still_runs_on_tags_and_on_pull_requests_to_main(workflow):
    triggers = workflow.get(True) or workflow.get("on")          # PyYAML reads the key "on" as True
    assert triggers["push"]["tags"] == ["v*"] and triggers["pull_request"]["branches"] == ["main"]


def test_a_tag_push_checks_the_release_documents_against_the_tag(workflow):
    steps = steps_running(workflow["jobs"]["checks"], "check_release_docs.py")
    tagged = [s for s in steps if "--tag" in s["run"]]
    assert len(tagged) == 1
    assert '"$GITHUB_REF_NAME"' in tagged[0]["run"]               # the pushed tag, not a guess
    assert tagged[0]["if"] == "github.ref_type == 'tag'"


def test_a_pull_request_to_main_checks_the_release_documents(workflow):
    steps = steps_running(workflow["jobs"]["checks"], "check_release_docs.py")
    plain = [s for s in steps if "--tag" not in s["run"]]
    assert len(plain) == 1 and plain[0]["if"] == "github.event_name == 'pull_request'"
    assert plain[0]["run"].strip() == "python scripts/check_release_docs.py"


def test_a_manual_run_is_not_blocked_by_the_documents(workflow):
    steps = steps_running(workflow["jobs"]["checks"], "check_release_docs.py")
    assert len(steps) == 2
    for step in steps:
        assert "workflow_dispatch" not in step["if"] and step["if"] in ("github.ref_type == 'tag'", "github.event_name == 'pull_request'")


def test_the_documents_are_checked_before_the_slow_steps(workflow):
    names = [str(s.get("run", "")) for s in workflow["jobs"]["checks"]["steps"]]
    gate = min(i for i, run in enumerate(names) if "check_release_docs.py" in run)
    assert gate < min(i for i, run in enumerate(names) if run.strip().startswith("pytest"))
    assert gate < min(i for i, run in enumerate(names) if "npm ci" in run)


def test_python_is_set_up_before_the_gate_runs(workflow):
    uses = [str(s.get("uses", "")) for s in workflow["jobs"]["checks"]["steps"]]
    runs = [str(s.get("run", "")) for s in workflow["jobs"]["checks"]["steps"]]
    gate = min(i for i, run in enumerate(runs) if "check_release_docs.py" in run)
    assert any(u.startswith("actions/setup-python") for u in uses[:gate])
    assert any(u.startswith("actions/checkout") for u in uses[:gate])


def test_publishing_waits_for_the_checks(workflow):
    assert "checks" in workflow["jobs"]["release"]["needs"] and workflow["jobs"]["release"]["if"] == "github.ref_type == 'tag'"


def test_the_gate_needs_nothing_but_python(workflow):
    """It must run before pip install, so it cannot import a third-party package."""
    source = (WORKFLOW.parent.parent.parent / "scripts" / "check_release_docs.py").read_text()
    imports = {line.split()[1].split(".")[0] for line in source.splitlines() if line.startswith(("import ", "from "))}
    assert imports <= {"argparse", "json", "re", "sys", "pathlib"}, imports
