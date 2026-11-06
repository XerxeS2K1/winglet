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
    # The gateway's control socket is in the main Hermes home; tmp_path stands in for a bot's own folder.
    host = tmp_path / 'host'
    from hermes_cli import profiles
    monkeypatch.setattr(profiles, '_get_default_hermes_home', lambda: host)
    from tools import async_delegation
    monkeypatch.setattr(async_delegation, 'list_async_delegations', lambda: [])
    with sqlite3.connect(tmp_path / 'state.db') as db:
        db.execute('CREATE TABLE session_admissions (seq INTEGER PRIMARY KEY, request_id TEXT, status TEXT)')
    return tmp_path, response, requests


def test_a_bots_work_is_asked_of_the_main_gateway_not_the_bots_own_folder(activity):
    home, _, requests = activity
    hermes_api.bot_activity(home, 'chef')
    assert requests[-1][0] == home / 'host' and requests[-1][0] != home


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
    assert requests[-1] == (home / 'host', 'active-work', {'params': {'profile': 'chef'}, 'timeout': 1.0})


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


def test_queue_details_follow_canonical_sequence_and_keep_only_short_display_fields(activity, monkeypatch):
    import json
    home, _, _ = activity
    from hermes_cli import profiles
    monkeypatch.setattr(profiles, 'profiles_to_serve', lambda **kw: [('chef', home)])
    def payload(author, text):
        return json.dumps({'text': text, 'local_automation_v1': {'turn_author': {'name': author, 'is_bot': True}},
                           'unrelated_private_field': 'must not leave server'})
    with sqlite3.connect(home / 'state.db') as db:
        db.execute("ALTER TABLE session_admissions ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'")
        db.executemany('INSERT INTO session_admissions VALUES (?, ?, ?, ?)', [
            (20, 'bot:second', 'queued', payload('research', 'Compare sources')),
            (10, 'bot:first', 'started', payload('hermes', 'Message from 🤖 Hermes (@hermes): Plan dinner\n\n(Answer in your reply to this message.)')),
            (30, 'bot:done', 'terminal', payload('secret', 'finished text'))])
    queue = hermes_api.bot_activities()['chef'].get('queue')
    assert queue == [
        {'id': 'bot:first', 'sequence': 10, 'from': 'hermes', 'title': 'Plan dinner', 'preview': 'Plan dinner', 'status': 'started'},
        {'id': 'bot:second', 'sequence': 20, 'from': 'research', 'title': 'Compare sources', 'preview': 'Compare sources', 'status': 'queued'}]
    assert 'must not leave server' not in json.dumps(queue)


def test_queue_display_is_bounded_without_changing_the_total_or_database(activity):
    import json
    home, _, _ = activity
    payload = json.dumps({'text': 'x' * 1000, 'local_automation_v1': {'turn_author': {'name': 'y' * 200}}})
    with sqlite3.connect(home / 'state.db') as db:
        db.execute("ALTER TABLE session_admissions ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'")
        db.executemany('INSERT INTO session_admissions VALUES (?, ?, ?, ?)',
                       [(i, f'bot:{i}', 'queued', payload) for i in range(55)])
    before = (home / 'state.db').read_bytes()
    activity = hermes_api.bot_activity(home, include_queue=True)
    assert activity['queued'] == 55
    assert len(activity['queue']) == 50
    assert all(len(row['title']) <= 61 for row in activity['queue'])   # a title is short however long the request
    assert activity['queue_truncated'] is True
    assert len(activity['queue'][0]['from']) == 60
    assert len(activity['queue'][0]['preview']) == 120
    assert (home / 'state.db').read_bytes() == before


@pytest.mark.parametrize('payload', ['not json', '[]', '{"private":"do not expose"}', 'x' * 70000])
def test_unknown_queue_payload_never_gets_stringified_as_a_preview(payload):
    row = hermes_api._bot_queue_entry(1, 'bot:id', 'queued', payload)
    assert row['preview'] == 'Details unavailable'
    assert row['from'] == 'Unknown sender'


def test_profiles_are_read_separately(activity, monkeypatch):
    home, _, _ = activity
    from hermes_cli import profiles
    monkeypatch.setattr(profiles, 'profiles_to_serve', lambda **kw: [('default', home), ('chef', home / 'missing')])
    assert hermes_api.bot_activities() == {'default': {'state': 'idle', 'queued': 0, 'queue': None, 'queue_truncated': False},
                                        'chef': {'state': 'unknown', 'queued': None, 'queue': None, 'queue_truncated': False}}
