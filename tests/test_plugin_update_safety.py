"""Regressions found by independent cold review of the complete updater.
Only sandbox backup/files, fake restart hook and benign child processes are used.
"""
import asyncio
import io
import json
import os
import signal
import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import threading

import pytest
from plugin import hermes_api as api, update_rollback as ur
from plugin import hub as hub_module
from test_control import hub, store  # noqa: F401
from test_plugin_update_flow import NEXT
from test_plugin_update_install import world, begin, NOW  # noqa: F401


async def test_watch_rollback_before_first_quiet_check_must_prevent_restart(world, hub):
    prepared = begin(world)
    # A delayed/stalled updater returns to a quiet gateway after the watch has acted.
    ur.watch(world.root, NOW + api.UPDATE_INSTALL_WINDOW_SECONDS + 1, io.StringIO())
    assert ur.read_marker(world.folder)['state'] == 'rolled_back'
    h = hub.hermes
    h.arm_deadline = api.arm_deadline
    h.hold_lease = api.hold_lease
    hub.activity_provider = lambda: {'default': {'state': 'idle', 'queued': 0}}
    job, _ = hub.store.create_job('winglet_update', detail={'boot': hub.boot_id, 'from': '0.10.4', 'to': '0.10.5'})
    await hub._restart_when_quiet(job['id'], h, prepared, '0.10.5')
    result = hub.store.get_job(job['id'])
    print('ROLLED_BACK_RESTART', json.dumps({'restart_calls': h.restarts, 'job_state': result['state'],
          'message': result['detail']['message'], 'marker_state': ur.read_marker(world.folder)['state']}))
    assert h.restarts == 0, 'a rolled-back update requested restart before checking its lease'


async def test_reconcile_must_not_call_an_unrequested_version_success(hub):
    job, _ = hub.store.create_job('winglet_update', detail={'boot': 'previous-process', 'from': '0.0.1', 'to': NEXT})
    assert hub_module.VERSION != NEXT
    await hub.reconcile_jobs()
    result = hub.store.get_job(job['id'])
    print('WRONG_TARGET_RECONCILE', json.dumps({'requested': NEXT, 'running': hub_module.VERSION,
          'state': result['state'], 'detail': result['detail']}))
    assert result['state'] != 'succeeded', 'version merely different from from-version is not proof of requested install'


@pytest.mark.parametrize('stop', ['timeout', 'cancel'])
async def test_stopped_installer_must_not_leave_a_writer_alive(tmp_path, monkeypatch, stop):
    if os.name == 'nt':
        pytest.skip('POSIX process-group integration; Windows needs taskkill verification')
    pytest.importorskip('hermes_cli.web_server')
    from hermes_cli import _launchers
    sentinel = tmp_path / 'grandchild-wrote-after-timeout'
    launcher_ready = tmp_path / 'launcher-ready'
    test_ready = tmp_path / 'test-ready'
    pidfile = tmp_path / 'grandchild-pid'
    child = tmp_path / 'benign-installer.py'
    grandchild_code = "import time,pathlib; time.sleep(0.5); pathlib.Path(%r).write_text('late write')" % str(sentinel)
    child.write_text('import subprocess,sys,time,pathlib\n'
        + 'p=subprocess.Popen([sys.executable,"-c",%r])\n' % grandchild_code
        + 'pathlib.Path(%r).write_text(str(p.pid))\n' % str(pidfile)
        + 'pathlib.Path(%r).touch()\n' % str(launcher_ready)
        + 'time.sleep(30)\n')
    original_exec = asyncio.create_subprocess_exec
    direct = []
    async def launch(*args, **kwargs):
        proc = await original_exec(*args, **kwargs)
        direct.append(proc)
        # Keep the countdown wait out of the launch helper: the timeout starts only after launch returns.
        for _ in range(200):
            if launcher_ready.exists():
                return proc
            await asyncio.sleep(0.005)
        raise AssertionError('benign child did not start')
    monkeypatch.setattr(_launchers, 'runtime_command', lambda root,args: [sys.executable,str(child)])
    async def launch_and_arm(*args, **kwargs):
        proc = await launch(*args, **kwargs)
        test_ready.touch()
        return proc
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', launch_and_arm)
    try:
        task = asyncio.create_task(api.install_release('a' * 40, timeout=0.05 if stop == 'timeout' else 30))
        if stop == 'cancel':
            for _ in range(200):
                if test_ready.exists():
                    break
                await asyncio.sleep(0.005)
            assert test_ready.exists() and launcher_ready.exists()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            code, lines = await task
            assert code == -1 and 'too long' in lines[0]
        await asyncio.sleep(0.7)
        assert not sentinel.exists(), 'a child outlived failure and could write after rollback'
        assert direct[0].returncode is not None
    finally:
        if pidfile.exists():
            try:
                os.kill(int(pidfile.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass
        for proc in direct:
            await proc.wait()


@pytest.mark.parametrize('gone', ['rolled_back', 'missing', 'different_backup'])
def test_deadline_and_final_restart_guard_never_revive_a_gone_update(world, monkeypatch, gone):
    prepared = begin(world)
    if gone == 'missing':
        ur.clear_marker(world.folder)
    else:
        marker = ur.read_marker(world.folder)
        assert marker is not None
        if gone == 'rolled_back':
            marker['state'] = 'rolled_back'
        else:
            marker['backup'] = 'plugin-0.10.4-pre-0.10.6-20270101-000000'
        ur.write_marker(world.folder, marker)
    original = (world.folder / ur.MARKER).read_bytes() if (world.folder / ur.MARKER).exists() else None
    restarts = []
    monkeypatch.setattr(api, 'spawn_restart', lambda: restarts.append(True))
    assert api.arm_deadline(prepared) is False
    assert api.restart_update(prepared) is None
    after = (world.folder / ur.MARKER).read_bytes() if (world.folder / ur.MARKER).exists() else None
    assert after == original and not restarts


def test_final_restart_guard_rechecks_after_a_rollback_during_phone_event_delay(world, monkeypatch):
    prepared = begin(world)
    assert api.arm_deadline(prepared, now=NOW)
    ur.watch(world.root, NOW + ur.DEADLINE_SECONDS + 1, io.StringIO())
    restarts = []
    monkeypatch.setattr(api, 'spawn_restart', lambda: restarts.append(True))
    assert api.restart_update(prepared) is None
    marker = ur.read_marker(world.folder)
    assert not restarts and marker is not None and marker['state'] == 'rolled_back'


def test_watch_and_restart_decision_are_serialized_between_threads(world, monkeypatch):
    prepared = begin(world)
    start, attempted, done = threading.Event(), threading.Event(), threading.Event()
    main = threading.get_ident()
    lock = ur.marker_lock
    @contextmanager
    def observed_lock(folder):
        if threading.get_ident() != main:
            attempted.set()
        with lock(folder):
            yield
    monkeypatch.setattr(ur, 'marker_lock', observed_lock)
    def restart():
        start.set()
        assert attempted.wait(2)
        assert not done.wait(0.05), 'watch must not restore files inside the final restart decision'
        marker = ur.read_marker(world.folder)
        assert marker is not None and marker['state'] == 'pending'
        return 123
    def watch():
        assert start.wait(2)
        try:
            return ur.watch(world.root, __import__('time').time() + 3600, io.StringIO())
        finally:
            done.set()
    monkeypatch.setattr(api, 'spawn_restart', restart)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(watch)
        assert api.restart_update(prepared) == 123
        assert future.result(timeout=3) == 0
    assert done.is_set()


@pytest.mark.parametrize('target,expected', [(None, 'unknown'), (hub_module.VERSION, 'succeeded'), (NEXT, 'failed')])
async def test_reconciliation_preserves_requested_version_and_ignores_an_unrelated_marker(hub, target, expected):
    hub.hermes.settled = {'outcome': 'rolled_back', 'from': 'other-start', 'to': 'other-target'}
    job, _ = hub.store.create_job('winglet_update', detail={'boot': 'previous-process', 'from': '0.0.1', 'to': target})
    await hub.reconcile_jobs()
    result = hub.store.get_job(job['id'])
    assert result['state'] == expected
    assert result['detail']['to'] == target
    assert result['detail']['running_version'] == hub_module.VERSION
