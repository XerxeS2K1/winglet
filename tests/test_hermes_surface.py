"""Every Hermes name the plugin imports still exists in the installed Hermes.

Hermes is not a stable API: it renamed or removed things between releases (`local_delivery_command` went away and
ask_bot vanished without an error). The plugin imports many Hermes names inside functions, so a missing one only
shows when that feature is used. This reads the plugin's imports and Hermes's source (without importing
Hermes) and fails on the first release that no longer has one, naming it. Where the plugin guards an import
(`try: ... except ImportError`), the feature switches itself off, so those are listed separately, not failed.

Runs only where Hermes is installed (CI has a job for it, and the weekly job runs it against Hermes main).
"""

import ast
import importlib.util
from pathlib import Path

import pytest

HERMES_TOP = ("gateway", "tools", "hermes_cli", "agent", "hermes_state", "hermes_constants", "tui_gateway",
              "hermes_state_runtime", "run_agent", "cron", "hermes_time", "model_tools")
PLUGIN = Path(__file__).resolve().parent.parent / "plugin"

spec = importlib.util.find_spec("hermes_cli")
pytestmark = pytest.mark.skipif(spec is None or not spec.submodule_search_locations, reason="needs Hermes Agent installed")


def _root() -> Path:
    return Path(list(spec.submodule_search_locations)[0]).parent


def _module_file(root: Path, module: str):
    base = root.joinpath(*module.split("."))
    for candidate in (base.with_suffix(".py"), base / "__init__.py"):
        if candidate.exists():
            return candidate
    return None


def _defined(path: Path) -> set:
    names = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8", errors="replace"))):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            names.update(t.id for t in node.targets if isinstance(t, ast.Name))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            names.update((a.asname or a.name).split(".")[0] for a in node.names)
    return names


def _guarded(tree) -> set:
    """Ids of import nodes inside a `try` whose handlers catch ImportError/Exception: Winglet copes if they fail."""
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Try) and any(
                h.type is None or "ImportError" in ast.dump(h.type) or "Exception" in ast.dump(h.type)
                or "ModuleNotFoundError" in ast.dump(h.type) for h in node.handlers):
            for child in node.body:
                for inner in ast.walk(child):
                    if isinstance(inner, ast.ImportFrom):
                        out.add(id(inner))
    return out


def _wanted():
    required, optional = {}, {}
    for path in sorted(PLUGIN.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
        guarded = _guarded(tree)
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module and node.level == 0 \
                    and node.module.split(".")[0] in HERMES_TOP:
                bucket = optional if id(node) in guarded else required
                for alias in node.names:
                    bucket.setdefault((node.module, alias.name), path.name)
    return required, optional


def _missing(wanted) -> list:
    root, cache, missing = _root(), {}, []
    for (module, name), where in sorted(wanted.items()):
        file = _module_file(root, module)
        if file is None:
            missing.append(f"{module} (module gone; imported by {where})")
            continue
        have = cache.setdefault(module, _defined(file))
        if name not in have and _module_file(root, f"{module}.{name}") is None:
            missing.append(f"{module}.{name} (imported by {where})")
    return missing


def test_the_plugin_found_its_hermes_imports():
    required, optional = _wanted()
    assert len(required) + len(optional) > 40  # the scan itself works


def test_every_hermes_name_the_plugin_needs_exists():
    required, _ = _wanted()
    assert not _missing(required), "Hermes no longer has: " + "; ".join(_missing(required))


def test_names_behind_a_fallback_are_reported_not_failed(capsys):
    _, optional = _wanted()
    gone = _missing(optional)
    if gone:  # a feature is off on this Hermes; worth seeing in the log, not a failure
        print("Features that switch themselves off on this Hermes:", "; ".join(gone))
