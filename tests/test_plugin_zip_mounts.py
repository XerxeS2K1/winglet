"""Install self-test: the plugin zip, built the way the release builds it, really mounts.

The other suites import `plugin` from the repository. A user never has that: they have the zip. A file that is in
the repository but missing from the zip (or a module that only imports because the repository is on the path) passes every
other test and breaks every install. So this one:

  1. builds the zip the way .github/workflows/release.yml does (`cp -r plugin winglet`, zip it, leave out __pycache__),
  2. unpacks it in a temporary folder and runs a fresh Python there that can see ONLY that folder (`-I`, no repository
     on the path, run from another directory), and checks in that Python that
       - the `winglet` package imports and `register()` registers the platform, the CLI command and the tools,
       - plugin.yaml's version is the version the hub reports,
       - the hub, built on the unpacked package's own web folder, serves the web app: `/`, the files it names, and the
         service worker, and every file the bundle refers to is there,
       - the update path has what it reads: the watchdog scripts are copied out and import on their own, and the
         installed tree verifies against the zip,
  3. does it again on copies with one needed file deleted, and expects each to be reported.

The web app is the committed plugin/web (the release rebuilds it from app/ first; scripts/check_web_bundle.py --fresh
guards that it is current). No network, no Hermes: the `gateway` modules the adapter imports are stubbed in the
fresh Python. About 10 s; paths are handled with pathlib/zipfile only, so it runs the same on Windows.
"""

import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parent.parent
PLUGIN = REPO / "plugin"
WORKFLOW = REPO / ".github" / "workflows" / "release.yml"


# ------------------------------------------------------------------------------------------ build the zip like the release

def build_release_zip(target: Path) -> Path:
    """`cp -r plugin winglet && zip -qr out.zip winglet -x 'winglet/__pycache__/*'`, without needing the zip program."""
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(PLUGIN.rglob("*")):
            rel = path.relative_to(PLUGIN).as_posix()
            if path.is_dir() or rel.split("/")[0] == "__pycache__":
                continue
            archive.write(path, f"winglet/{rel}")
    return target


@pytest.fixture(scope="module")
def release_zip(tmp_path_factory) -> Path:
    return build_release_zip(tmp_path_factory.mktemp("release") / "winglet-plugin-test.zip")


def unpack(archive: Path, where: Path) -> Path:
    where.mkdir(parents=True)
    with zipfile.ZipFile(archive) as z:
        z.extractall(where)
    return where


# ------------------------------------------------------------------------------ the checks, run in a fresh Python

DRIVER = r'''
import asyncio, json, os, re, subprocess, sys, types
from pathlib import Path

unpacked, repo, zip_path, work = (Path(a) for a in sys.argv[1:5])
sys.path.insert(0, str(unpacked))        # the only way to `winglet`: the unpacked zip
problems, facts = [], {}


def problem(text):
    problems.append(text)


# The adapter imports Hermes's gateway package, which is not here; give it just the names it takes.
class _Base:
    pass

for name, members in {
    "gateway": {}, "gateway.platforms": {},
    "gateway.config": {"Platform": str, "PlatformConfig": object},
    "gateway.platforms._shared": {n: (lambda *a, **k: None) for n in ("extra_or_secret", "get_scoped_secret", "seed_extra_from_env")},
    "gateway.platforms.base": {"BasePlatformAdapter": _Base, "ExecApprovalPrompt": object, "SendResult": object},
    "gateway.platforms.event": {"MessageEvent": object, "MessageType": types.SimpleNamespace(TEXT="text", COMMAND="command", PHOTO="photo", DOCUMENT="document", VOICE="voice", AUDIO="audio")},
    "tools": {}, "tools.registry": {"no_cache_check_fn": lambda fn: fn},     # the phone tools only register where Hermes has this
}.items():
    module = types.ModuleType(name)
    module.__dict__.update(members)
    sys.modules[name] = module

manifest = (unpacked / "winglet" / "plugin.yaml")
manifest_text = manifest.read_text(encoding="utf-8") if manifest.is_file() else ""
if not manifest_text:
    problem("plugin.yaml is missing from the zip")
version = re.search(r"(?m)^version:[ \t]*(\S+)", manifest_text)
provided = re.findall(r"(?m)^  - (\w+)$", manifest_text.split("provides_tools:", 1)[-1]) if "provides_tools:" in manifest_text else []

# 1. the package imports, from the unpacked folder, and registers
try:
    import winglet
    from winglet import adapter, hub, self_update, store
except Exception as exc:
    problem(f"importing the winglet package failed: {type(exc).__name__}: {exc}")
    print(json.dumps({"problems": problems, "facts": facts}))
    sys.exit(0)

if Path(winglet.__file__).resolve().parent != (unpacked / "winglet").resolve():
    problem(f"winglet was imported from {winglet.__file__}, not from the unpacked zip")


class Ctx:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        if not name.startswith("register"):
            raise AttributeError(name)

        def record(*args, **kwargs):
            self.calls.append((name, kwargs.get("name") or (args[0] if args else None)))
            return None
        return record

ctx = Ctx()
try:
    winglet.register(ctx)
except Exception as exc:
    problem(f"register() failed: {type(exc).__name__}: {exc}")
kinds = {(kind, what) for kind, what in ctx.calls}
facts["registered"] = sorted(f"{k}:{w}" for k, w in kinds)
if ("register_platform", "winglet") not in kinds:
    problem("register() did not register the winglet platform")
if ("register_cli_command", "winglet") not in kinds:
    problem("register() did not register the `hermes winglet` command")
tools = {w for k, w in kinds if k == "register_tool"}
for tool in provided:
    if tool not in tools:
        problem(f"plugin.yaml promises the tool {tool}, but register() did not register it")
if len(provided) < 3:
    problem("could not read provides_tools from plugin.yaml")

# Modules are also imported late (the tunnel, the exchange-rate fetch, the CLI), so a plain import above does not touch them all:
# every `from . import x` / `from .x import y` anywhere in the package must name a file that is in the zip.
import ast
package = unpacked / "winglet"
for source in sorted(package.rglob("*.py")):
    try:
        tree = ast.parse(source.read_text(encoding="utf-8"))
    except SyntaxError as exc:
        problem(f"{source.name} does not parse: {exc}")
        continue
    for node in ast.walk(tree):
        # `import plugin.x` is the repository's name for this folder; in an install the package is called winglet.
        spelled = [node.module or ""] if isinstance(node, ast.ImportFrom) and node.level == 0 else [a.name for a in node.names] if isinstance(node, ast.Import) else []
        for name in spelled:
            if name == "plugin" or name.startswith("plugin."):
                problem(f"{source.name} imports {name}, which only exists in the repository")
        if isinstance(node, ast.ImportFrom) and node.level == 1:
            base = source.parent
            names = [node.module.split(".")[0]] if node.module else [alias.name for alias in node.names]
            for name in names:
                if not ((base / f"{name}.py").is_file() or (base / name / "__init__.py").is_file()):
                    problem(f"{source.name} imports .{name}, which is not in the zip")

# 2. the version the manifest declares is the version the hub reports
if not version or version.group(1).strip("\"'") != hub.VERSION:
    problem(f"plugin.yaml says {version and version.group(1)}, the hub says {hub.VERSION}")
facts["version"] = hub.VERSION

# 3. the hub serves the web app that came in the zip, from the folder the adapter gives it
src = (unpacked / "winglet" / "adapter.py").read_text(encoding="utf-8")
if 'web_root=Path(__file__).parent / "web"' not in src:
    problem("adapter.py no longer builds the hub on Path(__file__).parent / \"web\": update this self-test with it")
web = Path(adapter.__file__).parent / "web"

async def serve():
    from aiohttp.test_utils import TestClient, TestServer
    if not (web / "index.html").is_file():
        problem("web/index.html is not in the zip")
    db = store.Store(work / "hub.db")
    app = hub.Hub(db, web_root=web, bot_info=lambda: {"name": "hermes", "title": "Hermes"}).build_app()
    async with TestClient(TestServer(app)) as client:
        async def get(path):
            async with client.get(path) as resp:
                return resp.status, resp.headers.get("Content-Type", ""), await resp.text(errors="replace")

        status, ctype, body = await get("/")
        if status != 200 or "<html" not in body.lower():
            problem(f"GET / answered {status}")
        elif "isn't bundled" in body:
            problem("GET / answered the 'web app is not bundled' page")
        status, _, body = await get("/chat/some-id")      # a client-side route falls back to the shell
        if status != 200 or "isn't bundled" in body:
            problem(f"GET /chat/some-id answered {status}")
        index = (web / "index.html").read_text(encoding="utf-8", errors="replace") if (web / "index.html").is_file() else ""
        wanted = set(re.findall(r"""(?:src|href)=["'](/[^"'?#]+)""", index)) | {"/sw.js", "/push-guard.js", "/manifest.webmanifest"}
        facts["served"] = len(wanted)
        for path in sorted(wanted):
            status, ctype, _ = await get(path)
            if status != 200:
                problem(f"the hub answered {status} for {path}")
        status, ctype, _ = await get("/manifest.webmanifest")
        if status == 200 and "manifest+json" not in ctype:
            problem(f"/manifest.webmanifest was served as {ctype}")
    db.close()

try:
    asyncio.run(serve())
except Exception as exc:
    problem(f"serving the web app failed: {type(exc).__name__}: {exc}")

# every file the bundle refers to is in it (the same rule as scripts/check_web_bundle.py, on the unpacked copy)
ref = re.compile(r"""["'(](/(?:assets|_expo/static|icons)/[^"'()\s?#]+)""")
refs = set()
for path in list(web.rglob("*.js")) + list(web.glob("*.html")) + list(web.glob("*.webmanifest")):
    refs.update(ref.findall(path.read_text(encoding="utf-8", errors="ignore")))
facts["bundle_refs"] = len(refs)
if len(refs) < 5:
    problem("found almost no asset references in the bundle: is the web app in the zip?")
for r in sorted(refs):
    if not (web / r.lstrip("/")).is_file():
        problem(f"the web bundle refers to {r}, which is not in the zip")

# 4. the update path has the files it reads
home = work / "hermes-home"
try:
    done = self_update.refresh_watchdog_scripts(home)
    scripts = Path(done["scripts"])
    for name in (self_update.WATCHDOG_SCRIPT, self_update.ROLLBACK_SCRIPT, "update_rollback.py", "rollback.py", "self_update.py"):
        if not (scripts / name).is_file():
            problem(f"the update path did not copy out {name}")
    # systemd runs these copies with nothing but their own folder: each must load on its own.
    code = ("import sys, importlib.util\n"
            "scripts = sys.argv[1]; sys.path.insert(0, scripts)\n"
            "import update_rollback, rollback, self_update\n"
            "for name in sys.argv[2:]:\n"
            "    spec = importlib.util.spec_from_file_location('copy_' + name.replace('-', '_').replace('.py', ''), scripts + '/' + name)\n"
            "    importlib.util.module_from_spec(spec); spec.loader.exec_module(importlib.util.module_from_spec(spec))\n")
    out = subprocess.run([sys.executable, "-I", "-c", code, str(scripts), self_update.WATCHDOG_SCRIPT, self_update.ROLLBACK_SCRIPT],
                         capture_output=True, text=True, cwd=str(work), timeout=60)
    if out.returncode != 0:
        problem("the watchdog scripts copied out do not import on their own: " + (out.stderr.strip().splitlines() or ["?"])[-1])
except Exception as exc:
    problem(f"the update watchdog scripts cannot be copied out of the package: {type(exc).__name__}: {exc}")
try:
    ok, why = self_update.verify_installed_plugin(unpacked / "winglet", zip_path.read_bytes(),
                                                  {"version": hub.VERSION, "requires_hermes": ">=0.22.7"})
    if not ok:
        problem(f"the unpacked plugin does not verify against its own zip: {why}")
except Exception as exc:
    problem(f"verifying the installed tree failed: {type(exc).__name__}: {exc}")

# 5. nothing came from the repository
stray = sorted({m.__file__ for m in list(sys.modules.values()) if getattr(m, "__file__", None) and Path(m.__file__).resolve().is_relative_to(repo.resolve())})
if stray:
    problem("modules were loaded from the repository, not the zip: " + ", ".join(stray[:3]))

print(json.dumps({"problems": problems, "facts": facts}))
'''


def run_checks(unpacked: Path, archive: Path, work: Path) -> dict:
    work.mkdir(parents=True, exist_ok=True)
    driver = work / "driver.py"
    driver.write_text(DRIVER, encoding="utf-8")
    done = subprocess.run([sys.executable, "-I", str(driver), str(unpacked), str(REPO), str(archive), str(work)],
                          capture_output=True, text=True, cwd=str(work), timeout=120)
    assert done.returncode == 0, f"the checking Python crashed:\n{done.stdout[-1500:]}\n{done.stderr[-1500:]}"
    return json.loads(done.stdout.strip().splitlines()[-1])


# ------------------------------------------------------------------------------------------------------------- the tests

def test_the_zip_is_built_the_way_the_release_builds_it():
    """The copy of the release's packaging above must not drift from the workflow."""
    workflow = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    script = "\n".join(str(step.get("run", "")) for step in workflow["jobs"]["plugin"]["steps"])
    assert "cp -r plugin winglet" in script
    assert re.search(r"zip -qr \"out/winglet-plugin-\$\{VERSION\}\.zip\" winglet -x 'winglet/__pycache__/\*'", script), script
    assert "./scripts/build-web.sh" in script          # the release builds the web app into plugin/web first; this test uses the committed copy


def test_the_zip_holds_everything_in_the_plugin_folder_under_winglet(release_zip):
    with zipfile.ZipFile(release_zip) as z:
        names = {n for n in z.namelist() if not n.endswith("/")}
    expected = {f"winglet/{p.relative_to(PLUGIN).as_posix()}" for p in PLUGIN.rglob("*")
                if p.is_file() and p.relative_to(PLUGIN).parts[0] != "__pycache__"}
    assert names == expected
    assert {"winglet/__init__.py", "winglet/plugin.yaml", "winglet/hub.py", "winglet/adapter.py", "winglet/web/index.html"} <= names
    assert not any("__pycache__" in n for n in names)


@pytest.fixture(scope="module")
def mounted(release_zip, tmp_path_factory):
    base = tmp_path_factory.mktemp("mount")
    return run_checks(unpack(release_zip, base / "unpacked"), release_zip, base / "work")


def test_the_unpacked_plugin_mounts_registers_serves_the_web_app_and_has_its_update_files(mounted):
    assert mounted["problems"] == []
    facts = mounted["facts"]
    assert "register_platform:winglet" in facts["registered"] and "register_cli_command:winglet" in facts["registered"]
    manifest = re.search(r"(?m)^version: *(\S+)", (PLUGIN / "plugin.yaml").read_text(encoding="utf-8"))
    assert manifest and facts["version"] == manifest.group(1)
    assert facts["served"] >= 5 and facts["bundle_refs"] >= 5       # the checks looked at something


# What each deletion must be reported as. One per kind of thing the install needs; the message says which file.
BREAKS = [
    ("web/index.html", "index.html"),                                  # the web app shell the hub serves
    ("web/sw.js", "/sw.js"),                                          # the service worker the shell registers
    ("update_watchdog.py", "update_watchdog.py"),                      # the update path's watchdog (copied out beside the unit)
    ("rollback.py", "rollback"),                                      # a module the watchdog copies import
    ("fx.py", "imports .fx"),                                         # a module the package imports late, when the hub starts
    ("plugin.yaml", "plugin.yaml"),                                   # the manifest Hermes reads
]


def _break(archive: Path, base: Path, how) -> list:
    unpacked = unpack(archive, base / "unpacked")
    how(unpacked / "winglet")
    return run_checks(unpacked, archive, base / "work")["problems"]


def _delete(rel):
    def how(package: Path):
        target = package / rel
        assert target.is_file(), f"{rel} is not in the zip to begin with"
        target.unlink()
    return how


def _delete_a_bundle_script(package: Path):
    scripts = sorted((package / "web" / "_expo" / "static" / "js").rglob("*.js"))
    assert scripts, "the committed web bundle has no script"
    scripts[0].unlink()


def _wrong_version(package: Path):
    manifest = package / "plugin.yaml"
    manifest.write_text(re.sub(r"(?m)^version: *\S+", "version: 0.0.1", manifest.read_text(encoding="utf-8")), encoding="utf-8")


def _repo_only_import(package: Path):
    """An import that works in the repository and nowhere else."""
    init = package / "__init__.py"
    init.write_text(init.read_text(encoding="utf-8") + f"\nimport sys\nsys.path.append({str(REPO)!r})\nimport plugin.fx\n", encoding="utf-8")


def _late_repo_import(package: Path):
    """The same mistake in a module that is only loaded late, so nothing imports it while the checks run."""
    late = package / "fx.py"
    late.write_text(late.read_text(encoding="utf-8") + "\nimport plugin.store\n", encoding="utf-8")


SCENARIOS = {f"delete {victim}": (_delete(victim), mention) for victim, mention in BREAKS}
SCENARIOS["delete a hashed web script"] = (_delete_a_bundle_script, "the web bundle refers to")
SCENARIOS["wrong version in plugin.yaml"] = (_wrong_version, "plugin.yaml says 0.0.1")
SCENARIOS["import that only works from the repository"] = (_repo_only_import, "repository")
SCENARIOS["late import of the repository's name"] = (_late_repo_import, "only exists in the repository")


@pytest.fixture(scope="module")
def broken(release_zip, tmp_path_factory):
    """Each scenario is its own unpack and its own fresh Python; they are independent, so run them side by side to stay quick."""
    from concurrent.futures import ThreadPoolExecutor
    bases = {name: tmp_path_factory.mktemp("break") for name in SCENARIOS}
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {name: pool.submit(_break, release_zip, bases[name], how) for name, (how, _) in SCENARIOS.items()}
        return {name: future.result() for name, future in futures.items()}


@pytest.mark.parametrize("name", list(SCENARIOS))
def test_a_broken_zip_is_reported(broken, name):
    """The check must be able to fail: the same checks, on an unpacked copy with one thing broken, say so and name it."""
    found = broken[name]
    assert found, f"{name}: not noticed"
    assert any(SCENARIOS[name][1] in p for p in found), found
