"""The release workflow runs the docs gate where it matters: on tag pushes, and on pull requests that target main.

A tag push is the release itself, so there the tag is checked as well (--tag). A pull request to main is the last chance to
catch missing release notes before the tag, so there the gate checks the version files. A manual run builds test artifacts
and publishes nothing, so it does not need them.
"""

import os
import shutil
import subprocess
import sys
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


# -- a failed check stops the release -------------------------------------------------------------------------------------------


def gate_steps(workflow):
    return steps_running(workflow["jobs"]["checks"], "check_release_docs.py")


def test_the_gates_are_exactly_the_commands_and_nothing_softens_them(workflow):
    expected = {"github.ref_type == 'tag'": 'python scripts/check_release_docs.py --tag "$GITHUB_REF_NAME"',
                "github.event_name == 'pull_request'": "python scripts/check_release_docs.py"}
    steps = gate_steps(workflow)
    assert {s["if"]: s["run"].strip() for s in steps} == expected         # no '|| true', no pipe, no extra commands
    for step in steps:
        assert "continue-on-error" not in step and "shell" not in step and "timeout-minutes" not in step
        assert not set(step) - {"name", "if", "run"}, set(step)


def test_nothing_in_the_chain_that_publishes_may_continue_after_a_failure(workflow):
    jobs = workflow["jobs"]
    assert "continue-on-error" not in jobs["checks"] and "continue-on-error" not in jobs["release"]
    assert all("continue-on-error" not in step for step in jobs["checks"]["steps"])
    assert set(jobs["release"]["needs"]) >= {"checks", "android", "plugin"}
    assert "always()" not in str(jobs["release"].get("if")) and "failure()" not in str(jobs["release"].get("if"))


def run_step(step, cwd, env):
    """Run a step the way GitHub does for bash: bash -e -o pipefail."""
    return subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", step["run"]], cwd=cwd, env=env,
                          capture_output=True, text=True)


@pytest.fixture
def checkout(tmp_path):
    """A repository root holding the real gate script, and a python on the PATH like the runner's."""
    (tmp_path / "scripts").mkdir()
    shutil.copy(WORKFLOW.parent.parent.parent / "scripts" / "check_release_docs.py", tmp_path / "scripts")
    (tmp_path / "plugin").mkdir()
    (tmp_path / "app").mkdir()
    (tmp_path / "docs" / "releases").mkdir(parents=True)
    (tmp_path / "plugin" / "plugin.yaml").write_text("name: winglet\nversion: 1.2.3\n")
    (tmp_path / "app" / "app.json").write_text('{"expo": {"version": "1.2.3"}}')
    (tmp_path / "README.md").write_text("> **New in [v1.2.3](docs/releases/v1.2.3.md):** x\n")
    (tmp_path / "docs" / "releases" / "v1.2.3.md").write_text("# Winglet v1.2.3\n\n" + "words " * 60)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "python").symlink_to(sys.executable)
    env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}"}
    return tmp_path, env


def test_a_failing_gate_fails_the_step_when_run_the_way_github_runs_it(workflow, checkout):
    root, env = checkout
    tag_step = next(s for s in gate_steps(workflow) if "--tag" in s["run"])
    assert run_step(tag_step, root, {**env, "GITHUB_REF_NAME": "v1.2.3"}).returncode == 0
    broken = run_step(tag_step, root, {**env, "GITHUB_REF_NAME": "v1.2.4"})
    assert broken.returncode != 0 and "does not match the version files" in broken.stdout
    pr_step = next(s for s in gate_steps(workflow) if "--tag" not in s["run"])
    assert run_step(pr_step, root, env).returncode == 0
    (root / "docs" / "releases" / "v1.2.3.md").unlink()
    missing = run_step(pr_step, root, env)
    assert missing.returncode != 0 and "docs/releases/v1.2.3.md does not exist" in missing.stdout


def ancestry_step(workflow):
    steps = steps_running(workflow["jobs"]["checks"], "is-ancestor")
    assert len(steps) == 1, "A tag must be proven to be on main"
    return steps[0]


def git(cwd, *args):
    return subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", *args],
                          cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture
def repository(tmp_path):
    server, work, runner = (tmp_path / name for name in ("server.git", "work", "runner"))
    git(tmp_path, "init", "--bare", "-b", "main", str(server))
    git(tmp_path, "clone", str(server), str(work))
    (work / "a").write_text("main")
    git(work, "add", "a")
    git(work, "commit", "-m", "on main")
    main = git(work, "rev-parse", "HEAD")
    git(work, "push", "origin", "main")
    git(work, "checkout", "-b", "integration/dev-all")
    (work / "b").write_text("side")
    git(work, "add", "b")
    git(work, "commit", "-m", "not yet on main")
    side = git(work, "rev-parse", "HEAD")
    git(work, "push", "origin", "integration/dev-all")
    git(tmp_path, "clone", str(server), str(runner))
    return work, runner, main, side


def check_ancestry(workflow, runner, sha):
    git(runner, "checkout", "--detach", sha)
    return run_step(ancestry_step(workflow), runner,
                    {**os.environ, "GITHUB_SHA": sha, "GITHUB_REF_NAME": "v1.2.3"})


def test_tag_on_main_is_allowed(workflow, repository):
    _, runner, main, _ = repository
    assert check_ancestry(workflow, runner, main).returncode == 0


def test_tag_outside_main_is_refused_with_an_actionable_error(workflow, repository):
    _, runner, _, side = repository
    result = check_ancestry(workflow, runner, side)
    assert result.returncode != 0
    assert "::error::Tag v1.2.3 is not on main" in result.stdout + result.stderr


def test_old_main_commit_is_allowed_after_main_advances(workflow, repository):
    work, runner, main, _ = repository
    git(work, "checkout", "main")
    (work / "c").write_text("later")
    git(work, "add", "c")
    git(work, "commit", "-m", "later main")
    git(work, "push", "origin", "main")
    assert check_ancestry(workflow, runner, main).returncode == 0


def test_side_commit_is_allowed_once_merged_into_main(workflow, repository):
    work, runner, _, side = repository
    git(work, "checkout", "main")
    git(work, "merge", "--no-ff", "-m", "release", "integration/dev-all")
    git(work, "push", "origin", "main")
    assert check_ancestry(workflow, runner, side).returncode == 0


def test_ancestry_check_is_tag_only_blocking_and_early(workflow):
    step = ancestry_step(workflow)
    assert step["if"] == "github.ref_type == 'tag'"
    assert "continue-on-error" not in step
    steps = workflow["jobs"]["checks"]["steps"]
    assert steps.index(step) < next(i for i, s in enumerate(steps) if str(s.get("run", "")).startswith("pytest"))


def test_checkout_provides_history_for_tag_ancestry(workflow):
    checkout = next(s for s in workflow["jobs"]["checks"]["steps"] if str(s.get("uses", "")).startswith("actions/checkout"))
    assert str(checkout.get("with", {}).get("fetch-depth")) in ("0", "${{ github.ref_type == 'tag' && 0 || 1 }}")
