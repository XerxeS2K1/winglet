"""Offline update rehearsal: signed HTTP -> real backup -> real child process -> rollback/reconcile.

The child is an installer test double, NOT a real Hermes installation. It parses the real
Hermes CLI and exercises its real active-plugin publication consent gate. Only PM's
package/tree publication is replaced by a sandbox copy/fault: no network, packages,
live plugin, real cron job, or gateway restart is allowed.
"""
import asyncio
import json
import sqlite3
import sys
from pathlib import Path

import pytest

from plugin import hermes_api as api
from plugin import hub as hub_module
from plugin import update_rollback as ur
from test_control import client, hub, settle, store  # noqa: F401
from test_plugin_update_flow import NEXT, RELEASE, owner, update  # noqa: F401
from test_plugin_update_install import world, rows  # noqa: F401


CHILD = '''
import argparse, json, pathlib, shutil, sys
from hermes_cli.subcommands.plugins import build_plugins_parser
from hermes_cli.plugins_transaction import publish_plugin
from pm import client, workspace
p = argparse.ArgumentParser()
build_plugins_parser(p.add_subparsers(), cmd_plugins=lambda args: None)
args = p.parse_args(sys.argv[1:])
root = pathlib.Path(__import__('os').environ['HERMES_HOME'])
target = root / 'plugins' / 'winglet'
staged = root / 'staged'
staged.mkdir()
(staged / 'plugin.yaml').write_text('name: winglet\\nversion: 0.99.0\\npython_dependencies:\\n  - httpx>=0.27,<1\\n')
(staged / 'hub.py').write_text('VERSION = "0.99.0"\\n')
workspace.enabled_plugin_dirs = lambda **kw: [target.resolve()]
meta = root / 'plugins' / '.install-metadata.json'
old = json.loads(meta.read_text())
def sandbox_publish(**kwargs):
    # ONLY test data changes. No package manager or live environment is invoked.
    shutil.rmtree(target)
    shutil.copytree(staged, target)
    meta.write_text(json.dumps({'winglet': {'pinned': True, 'revision': args.ref}}))
    if (root / 'fail-install').exists():
        raise RuntimeError('injected publication failure after sandbox write')
client.sync_venv = sandbox_publish
try:
    publish_plugin(staged, target, old, {}, require_consent=True, assume_consent=args.yes_deps)
except Exception as exc:
    print(str(exc), flush=True)
    sys.exit(1)
print('Sandbox publication completed', flush=True)
'''


@pytest.fixture
def rehearsal(world, hub, monkeypatch):
    pytest.importorskip('hermes_cli.web_server', reason='requires Hermes source/dependencies')
    script = world.root / 'installer-double.py'
    script.write_text(CHILD)
    (world.plugin / 'plugin.yaml').write_text(f'name: winglet\nversion: {hub_module.VERSION}\n')
    original = (world.plugin / 'plugin.yaml').read_bytes()
    env_path = ':'.join(sys.path)
    real_exec = asyncio.create_subprocess_exec
    calls = []

    def command(root, args=(), **kw):
        return [sys.executable, str(script), *args]

    async def spawn(*args, **kw):
        calls.append(args)
        kw['env'] = {**kw['env'], 'PYTHONPATH': env_path}
        return await real_exec(*args, **kw)

    monkeypatch.setattr('hermes_cli._launchers.runtime_command', command)
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn)
    monkeypatch.setattr(api, '_home', lambda: world.root)
    h = hub.hermes
    h.begin_update = lambda release, version: api.begin_update(
        release, version, plugin_dir=world.plugin, db_path=world.db, home=world.root)
    h.install_release = api.install_release
    h.installed_version_is = lambda version: api.installed_version_is(version, plugin_dir=world.plugin)
    h.cancel_update = api.cancel_update
    h.arm_deadline = api.arm_deadline
    h.settle_pending_update = lambda version: api.settle_pending_update(version, home=world.root)
    return world, calls, original


async def test_signed_update_crosses_real_noninteractive_consent_and_recovers_after_boot(client, hub, owner, rehearsal, monkeypatch):
    w, calls, _ = rehearsal
    response = await update(client, owner, version=NEXT)
    assert response.status == 202
    job_id = (await response.json())['job']['id']
    await settle(hub)
    assert len(calls) == 1 and '--yes-deps' in calls[0]
    assert api.installed_version_is(NEXT, plugin_dir=w.plugin)
    assert hub.hermes.restarts == 1  # FakeHermes hook only, no real restart
    assert hub.store.get_job(job_id)['state'] == 'running'
    marker = ur.read_marker(w.folder)
    assert marker is not None and marker['state'] == 'pending'
    hub.boot_id = 'new-simulated-boot'
    monkeypatch.setattr(hub_module, 'VERSION', NEXT)
    await hub.reconcile_jobs()
    assert hub.store.get_job(job_id)['state'] == 'succeeded'
    assert ur.read_marker(w.folder) is None and w.cron.removed == ['job1']
    assert rows(w.db) == ['before']


async def test_partial_child_failure_restores_files_metadata_not_new_messages_and_never_restarts(client, hub, owner, rehearsal):
    w, calls, original = rehearsal
    (w.root / 'fail-install').touch()
    response = await update(client, owner, version=NEXT)
    job_id = (await response.json())['job']['id']
    # Message written by the old gateway while the child is running must survive rollback.
    with sqlite3.connect(w.db) as db:
        db.execute("INSERT INTO messages(text) VALUES ('during install')")
    await settle(hub)
    job = hub.store.get_job(job_id)
    assert len(calls) == 1 and job['state'] == 'failed'
    assert 'injected publication failure' in '\n'.join(job['detail']['lines'])
    assert 'put back' in job['detail']['message'] and hub.hermes.restarts == 0
    assert (w.plugin / 'plugin.yaml').read_bytes() == original
    assert json.loads((w.root / 'plugins' / '.install-metadata.json').read_text())['winglet']['ref'] == 'old'
    assert rows(w.db) == ['before', 'during install']
    assert ur.read_marker(w.folder) is None and w.cron.removed == ['job1']


async def test_child_without_yes_deps_reproduces_live_refusal_without_publication(rehearsal):
    w, _, original = rehearsal
    from hermes_cli._launchers import runtime_command
    # Deliberately run the old command against the test double. Nothing reaches live Hermes.
    proc = await asyncio.create_subprocess_exec(*runtime_command(w.root, ('plugins', 'install', 'XerxeS2K1/winglet/plugin',
        '--ref', RELEASE['sha'], '--force', '--no-enable')), env={'HERMES_HOME': str(w.root)},
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    out, _ = await proc.communicate()
    assert proc.returncode == 1 and b'dependency install skipped (non-interactive)' in out
    assert (w.plugin / 'plugin.yaml').read_bytes() == original
