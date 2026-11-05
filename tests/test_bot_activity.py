"""Activity reads only temporary SQLite data and a fake read-only control verb."""
import sqlite3

import pytest
from plugin import hermes_api


@pytest.fixture
def activity(tmp_path, monkeypatch):
    control = pytest.importorskip('gateway.control_socket')
    requests = []
    response = {'active_agents': 0}
    def query(home, verb, **kwargs):
        requests.append((home, verb, kwargs))
        return response
    monkeypatch.setattr(control, 'query_gateway_control', query)
    from tools import async_delegation
    monkeypatch.setattr(async_delegation, 'list_async_delegations', lambda: [])
    with sqlite3.connect(tmp_path / 'state.db') as db:
        db.execute('CREATE TABLE session_admissions (seq INTEGER PRIMARY KEY, request_id TEXT, status TEXT)')
    return tmp_path, response, requests


def test_background_delegation_keeps_its_own_profile_working(activity, monkeypatch):
    home, _, _ = activity
    from tools import async_delegation
    from gateway.session import _session_key_namespace
    monkeypatch.setattr(async_delegation, 'list_async_delegations', lambda: [
        {'status': 'running', 'session_key': _session_key_namespace('chef') + ':winglet:chat'}])
    assert hermes_api.bot_activity(home, 'chef')['state'] == 'working'
    assert hermes_api.bot_activity(home, 'default')['state'] == 'idle'


def test_idle_and_working_are_profile_scoped(activity):
    home, response, requests = activity
    assert hermes_api.bot_activity(home, 'chef') == {'state': 'idle', 'queued': 0}
    response['active_agents'] = 1
    assert hermes_api.bot_activity(home, 'chef') == {'state': 'working', 'queued': 0}
    assert requests[-1] == (home, 'active-work', {'params': {'profile': 'chef'}, 'timeout': 1.0})


def test_queue_updates_from_canonical_rows_not_receipts(activity):
    home, response, _ = activity
    with sqlite3.connect(home / 'state.db') as db:
        db.executemany('INSERT INTO session_admissions VALUES (?, ?, ?)', [
            (1, 'bot:first', 'started'), (2, 'bot:second', 'queued'),
            (3, 'bot:third', 'queued'), (4, 'human', 'queued'),
            (5, 'bot:finished', 'terminal')])
    assert hermes_api.bot_activity(home) == {'state': 'working', 'queued': 2}
    with sqlite3.connect(home / 'state.db') as db:
        db.execute("UPDATE session_admissions SET status='terminal' WHERE seq=1")
        db.execute("UPDATE session_admissions SET status='started' WHERE seq=2")
    assert hermes_api.bot_activity(home) == {'state': 'working', 'queued': 1}


@pytest.mark.parametrize('reply', [None, {}, {'active_agents': -1}, {'active_agents': '0'}, {'active_agents': True}])
def test_missing_or_malformed_live_state_is_not_idle(activity, monkeypatch, reply):
    home, _, _ = activity
    from gateway import control_socket
    monkeypatch.setattr(control_socket, 'query_gateway_control', lambda *a, **k: reply)
    assert hermes_api.bot_activity(home)['state'] == 'unknown'


def test_missing_database_is_not_created(activity):
    home, _, _ = activity
    missing = home / 'missing'
    assert hermes_api.bot_activity(missing) == {'state': 'unknown', 'queued': None}
    assert not missing.exists()


def test_old_schema_degrades_without_writing(activity):
    home, _, _ = activity
    with sqlite3.connect(home / 'state.db') as db:
        db.execute('DROP TABLE session_admissions')
    before = (home / 'state.db').read_bytes()
    assert hermes_api.bot_activity(home) == {'state': 'unknown', 'queued': None}
    assert (home / 'state.db').read_bytes() == before


def test_profiles_are_read_separately(activity, monkeypatch):
    home, _, _ = activity
    from hermes_cli import profiles
    monkeypatch.setattr(profiles, 'profiles_to_serve', lambda **kw: [('default', home), ('chef', home / 'missing')])
    assert hermes_api.bot_activities() == {'default': {'state': 'idle', 'queued': 0},
                                        'chef': {'state': 'unknown', 'queued': None}}
