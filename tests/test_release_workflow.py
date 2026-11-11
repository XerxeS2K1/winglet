"""The release workflow runs the docs gate where it matters: on tag pushes, and on pull requests that target main.

A tag push is the release itself, so there the tag is checked as well (--tag). A pull request to main is the last chance to
catch missing release notes before the tag, so there the gate checks the version files. A manual run builds test artifacts
and publishes nothing, so it does not need them.
"""

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

WORKFLOW = Path(__file__).resolve().parent.parent / ".github" / "workflows" / "release.yml"


@pytest.fixture(scope="module")
def workflow():
    # The workflow has UTF-8 characters; Windows defaults to cp1252 and cannot decode them.
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


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
    source = (WORKFLOW.parent.parent.parent / "scripts" / "check_release_docs.py").read_text(encoding="utf-8")
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
    return subprocess.run([bash_executable(), "--noprofile", "--norc", "-eo", "pipefail", "-c", step["run"]], cwd=cwd, env=env,
                          capture_output=True, text=True, encoding="utf-8")


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
                          cwd=cwd, check=True, capture_output=True, text=True, encoding="utf-8").stdout.strip()


def bash_executable():
    """Git Bash on Windows: the bare `bash` in System32 is the WSL launcher, which has no distro here."""
    if sys.platform == "win32":
        git = shutil.which("git")
        if git:
            root = Path(git).resolve().parent.parent
            for candidate in (root / "bin" / "bash.exe", root / "usr" / "bin" / "bash.exe"):
                if candidate.exists():
                    return str(candidate)
    return "bash"


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
    # Numeric zero is falsy in GitHub expressions: `tag && 0 || 1` silently selects depth 1.
    assert checkout.get("with", {}).get("fetch-depth") == 0


def test_failed_fetch_refuses_even_a_tag_on_stale_cached_main(workflow, repository):
    _, runner, main, _ = repository
    # Cached origin/main would accept the tag. A failed refresh must stop before trusting it.
    assert git(runner, "rev-parse", "refs/remotes/origin/main") == main
    git(runner, "remote", "set-url", "origin", str(runner / "missing-remote.git"))
    result = check_ancestry(workflow, runner, main)
    assert result.returncode != 0
    assert "fatal:" in result.stderr


# ---------------------------------------------------------------------------------------------------------------------
# Manual test builds: `timing` and `r8` can be asked for on a manual run, and only there.
# ---------------------------------------------------------------------------------------------------------------------



# The three kinds of run that matter, plus a manual run started from a tag (GitHub allows choosing a tag as the ref).
RUNS = {
    "tag push": ("push", "tag", {}),
    "pull request": ("pull_request", "branch", {}),
    "manual": ("workflow_dispatch", "branch", {}),
    "manual from a tag": ("workflow_dispatch", "tag", {}),
}
ASKED = [(False, False), (True, False), (False, True), (True, True)]
SWITCHES = ("EXPO_PUBLIC_WINGLET_PERF", "WINGLET_MINIFY")


def expression(text):
    """Evaluate the small part of GitHub's expression language the workflow uses (contexts, == != && || and 'strings'),
    with the same truthiness: an empty string, false and null are false. Anything it does not understand raises."""
    text = str(text).strip()
    inner = re.fullmatch(r"\$\{\{(.*)\}\}", text, re.S)
    return (inner.group(1) if inner else text).strip()


def evaluate(text, event, ref_type, timing=None, r8=None):
    source = expression(text)
    names = {"github.event_name": event, "github.ref_type": ref_type, "inputs.timing": timing, "inputs.r8": r8}
    literals = []
    source = re.sub(r"'([^']*)'", lambda m: literals.append(m.group(1)) or f"@{len(literals) - 1}@", source)
    for name in sorted(names, key=len, reverse=True):
        source = source.replace(name, f"names[{name!r}]")
    source = source.replace("&&", " and ").replace("||", " or ")
    source = re.sub(r"@(\d+)@", lambda m: repr(literals[int(m.group(1))]), source)
    rest = re.sub(r"names\['[^']*'\]", "", source)
    assert "github." not in rest and "inputs." not in rest, source                                       # an unknown context
    return eval(source, {"__builtins__": {}}, {"names": names, "True": True, "False": False, "None": None})  # noqa: S307


def android(workflow):
    return workflow["jobs"]["android"]


def step_named(workflow, start):
    found = [s for s in android(workflow)["steps"] if str(s.get("name", "")).startswith(start)]
    assert len(found) == 1, (start, len(found))
    return found[0]


def position(workflow, step):
    return android(workflow)["steps"].index(step)


def test_a_manual_run_offers_timing_and_r8_as_checkboxes_that_start_off(workflow):
    inputs = workflow[True]["workflow_dispatch"]["inputs"]
    assert set(inputs) == {"timing", "r8"}
    for name in ("timing", "r8"):
        assert inputs[name]["type"] == "boolean" and inputs[name]["default"] is False, name
        assert inputs[name]["description"]
    # nothing else can carry them: a tag push and a pull request have no inputs to fill in
    assert "inputs" not in workflow[True]["push"] and "inputs" not in workflow[True]["pull_request"]


def test_the_switches_reach_the_build_only_for_a_manual_run_that_asked_and_not_from_a_tag(workflow):
    env = step_named(workflow, "Build release APKs")["env"]
    for (label, (event, ref_type, _)), (timing, r8) in ((r, a) for r in RUNS.items() for a in ASKED):
        got = {k: evaluate(env[k], event, ref_type, timing, r8) for k in SWITCHES}
        manual_test = event == "workflow_dispatch" and ref_type == "branch"
        want = {"EXPO_PUBLIC_WINGLET_PERF": "1" if manual_test and timing else "", "WINGLET_MINIFY": "1" if manual_test and r8 else ""}
        assert got == want, (label, timing, r8, got)


def test_the_switches_are_set_nowhere_else_in_the_workflow(workflow):
    """One step sets them (the build step); the guard only reads them. A second place could switch them on for a release."""
    setters = [(job, step.get("name", step.get("uses"))) for job, body in workflow["jobs"].items() for step in body["steps"]
               if any(name in step.get("env", {}) for name in SWITCHES)]
    assert setters == [("android", "Build release APKs")], setters
    for job, body in workflow["jobs"].items():
        assert not any(name in body.get("env", {}) for name in SWITCHES), job                 # not at job level
        assert not any(name in str(step.get("with", "")) for step in body["steps"] for name in SWITCHES), job
    assert "env" not in workflow or not any(name in workflow["env"] for name in SWITCHES)      # nor for the whole workflow
    for body in workflow["jobs"].values():                                                     # nor written into GITHUB_ENV
        for step in body["steps"]:
            for line in str(step.get("run", "")).splitlines():
                assert not ("GITHUB_ENV" in line and any(name in line for name in SWITCHES)), line
    for job in ("checks", "plugin", "release"):
        assert not any(n in str(workflow["jobs"][job]) for n in SWITCHES + ("inputs.",)), job


def guard_step(workflow):
    return step_named(workflow, "No timing or R8 outside a manual test run")


def test_a_guard_stops_a_run_that_is_not_a_manual_test_build_but_has_either_switch(workflow):
    guard = guard_step(workflow)
    build = step_named(workflow, "Build release APKs")
    assert position(workflow, guard) < position(workflow, build)
    assert "continue-on-error" not in guard
    for label, (event, ref_type, _) in RUNS.items():
        runs = bool(evaluate(guard["if"], event, ref_type))
        assert runs == (label != "manual"), label            # every run except a plain manual one is guarded


def run_guard(workflow, tmp_path, **env):
    step = {"run": guard_step(workflow)["run"]}
    base = {k: v for k, v in os.environ.items() if k not in SWITCHES}
    return run_step(step, tmp_path, {**base, **env})


def test_the_guard_really_fails_when_asked_for_either_switch_and_passes_when_clean(workflow, tmp_path):
    assert run_guard(workflow, tmp_path).returncode == 0
    assert run_guard(workflow, tmp_path, ASKED_TIMING="false", ASKED_R8="false").returncode == 0
    for extra in ({"ASKED_TIMING": "true"}, {"ASKED_R8": "true"}, {"EXPO_PUBLIC_WINGLET_PERF": "1"}, {"WINGLET_MINIFY": "1"}):
        result = run_guard(workflow, tmp_path, **extra)
        assert result.returncode != 0 and "::error::" in result.stdout and "never for a tag" in result.stdout, extra
    # the guard's own inputs are the same two inputs the build uses
    assert set(guard_step(workflow)["env"].values()) == {"${{ inputs.timing }}", "${{ inputs.r8 }}"}


def label_step(workflow):
    return step_named(workflow, "Name a manual test build after its switches")


def test_a_manual_test_build_names_its_files_after_the_switches_and_nothing_else_does(workflow, tmp_path):
    step = label_step(workflow)
    assert position(workflow, step_named(workflow, "Work out the version")) < position(workflow, step) < position(workflow, step_named(workflow, "Rename APKs"))
    for label, (event, ref_type, _) in RUNS.items():
        assert bool(evaluate(step["if"], event, ref_type)) == (label == "manual"), label
    for timing, r8, suffix in ((False, False, ""), (True, False, "-timing"), (False, True, "-r8"), (True, True, "-timing-r8")):
        github_env = tmp_path / f"env-{timing}-{r8}"
        github_env.write_text("")
        env = {**os.environ, "APK_LABEL": "dev-abc1234", "GITHUB_ENV": str(github_env),
               "ASKED_TIMING": str(timing).lower(), "ASKED_R8": str(r8).lower()}
        assert run_step(step, tmp_path, env).returncode == 0
        assert github_env.read_text().strip() == f"APK_LABEL=dev-abc1234{suffix}", (timing, r8)
    # A tag release keeps the bare version as its label, and the files are renamed from that label.
    version = step_named(workflow, "Work out the version")["run"]
    assert 'LABEL="$VERSION"' in version.split("else")[0] and "timing" not in version and "r8" not in version
    assert 'winglet-${APK_LABEL}-${ABI}.apk' in step_named(workflow, "Rename APKs")["run"]


def test_a_manual_run_still_publishes_nothing_and_the_publish_job_ignores_the_switches(workflow):
    release = workflow["jobs"]["release"]
    assert release["if"] == "github.ref_type == 'tag'"
    assert set(release["needs"]) >= {"checks", "android", "plugin"}
    for label, (event, ref_type, _) in RUNS.items():
        assert bool(evaluate(release["if"], event, ref_type)) == (ref_type == "tag"), label
    assert not any(word in str(release) for word in ("timing", "r8", "inputs.", "WINGLET_MINIFY", "PERF"))
    assert "workflow_dispatch" not in str(release)
