"""Room memberships use the project transaction and never own room data."""
import json
import types

import pytest

from plugin.hub import Hub
from plugin.rooms import Rooms, _SCHEMA
from test_trust import pair_phone

from plugin.projects import ProjectConflict, ProjectError, Projects
from plugin.store import Store


@pytest.fixture
def setup(tmp_path):
    store = Store(tmp_path / 'data.db')
    device, _ = store.add_device('Owner')
    device = store.get_device(device['id'])
    projects = Projects(store)
    project = projects.create(device, None, {'name': 'Work', 'client_id': 'create-room-project'})['project']
    yield store, projects, device, project
    store.close()


def test_move_remove_replay_and_conflict(setup):
    store, projects, device, project = setup
    room = {'members': [{'profile': 'default'}, {'profile': 'other'}], 'archived': False}
    body = {'revision': project['revision'], 'client_id': 'move-room-001'}
    first = projects.move_room(device, None, 'room-1', project['id'], body, room)
    assert first == projects.move_room(device, None, 'room-1', project['id'], body, room)
    assert store._one('SELECT project_id FROM project_rooms WHERE room_id=?', ('room-1',))['project_id'] == project['id']
    with pytest.raises(ProjectConflict):
        projects.move_room(device, None, 'room-1', None,
                           {'from_project_id': project['id'], 'from_revision': 1, 'client_id': 'remove-room-stale'}, room)
    projects.move_room(device, None, 'room-1', None,
                       {'from_project_id': project['id'], 'from_revision': 2, 'client_id': 'remove-room-good'}, room)
    assert store._one('SELECT * FROM project_rooms WHERE room_id=?', ('room-1',)) is None


def test_move_between_projects_checks_both_revisions(setup):
    _, projects, device, first = setup
    second = projects.create(device, None, {'name': 'Other', 'client_id': 'create-second-room-project'})['project']
    room = {'members': [{'profile': 'default'}, {'profile': 'other'}]}
    projects.move_room(device, None, 'room-1', first['id'],
                       {'revision': 1, 'client_id': 'move-first-room'}, room)
    body = {'from_project_id': first['id'], 'from_revision': 1, 'revision': 1,
            'client_id': 'move-second-room-stale'}
    with pytest.raises(ProjectConflict):
        projects.move_room(device, None, 'room-1', second['id'], body, room)
    body.update(from_revision=2, client_id='move-second-room-good')
    projects.move_room(device, None, 'room-1', second['id'], body, room)
    snapshot = projects.snapshot(device, None)
    assert {p['id']: p['revision'] for p in snapshot['projects']} == {first['id']: 3, second['id']: 2}


def test_roster_and_archived_room_are_rejected(setup):
    _, projects, device, project = setup
    for room in ({'members': [{'profile': 'other'}]},
                 {'members': [{'profile': 'default'}], 'archived': True}):
        with pytest.raises(ProjectError):
            projects.move_room(device, None, 'room-1', project['id'],
                               {'revision': 1, 'client_id': 'invalid-room-001'}, room)


def test_project_delete_releases_link(setup):
    store, projects, device, project = setup
    projects.move_room(device, None, 'room-1', project['id'],
                       {'revision': 1, 'client_id': 'move-room-delete'},
                       {'members': [{'profile': 'default'}]})
    projects.delete(device, None, project['id'], {'revision': 2, 'client_id': 'delete-room-project'})
    assert store._one('SELECT * FROM project_rooms WHERE room_id=?', ('room-1',)) is None


@pytest.fixture
async def room_http(aiohttp_client, tmp_path):
    store = Store(tmp_path / 'http.db')
    hub = Hub(store, web_root=tmp_path / 'web')
    rooms = Rooms.__new__(Rooms)
    rooms.hub, rooms.path = hub, str(tmp_path / 'rooms.db')
    rooms.worker = types.SimpleNamespace(runtime=types.SimpleNamespace(status=lambda: {'running': True}))
    with rooms._db() as db:
        db.executescript(_SCHEMA)
        db.execute('INSERT INTO winglet_rooms VALUES (?, ?, ?, ?, 0, ?, 1, 1, 1)',
                   ('room-one', 'Secret room', json.dumps([{'profile': 'default'}, {'profile': 'other'}]),
                    '["epoch-one"]', '[]'))
    hub.rooms = rooms
    client = await aiohttp_client(hub.build_app())
    yield client, hub, rooms
    store.close()


async def signed(client, phone, method, path, payload):
    body = json.dumps(payload).encode()
    return await client.request(method, path, data=body, headers=phone.signed(method, path, body))


async def test_project_rooms_capability_tracks_room_availability(room_http):
    _, hub, _ = room_http
    assert hub.features()['project_rooms'] is True
    assert hub.features()['project_rooms_sync'] is True
    hub.rooms = None
    assert hub.features()['project_rooms'] is False
    assert hub.features()['project_rooms_sync'] is False


@pytest.mark.parametrize('bot', [None, 'other'])
async def test_room_metadata_update_refreshes_its_project_scope(room_http, bot):
    client, hub, rooms = room_http
    owner = await pair_phone(client, hub)
    device = hub.store.get_device(owner.id)
    project = hub.projects.create(device, bot, {'name': 'Work', 'client_id': 'metadata-project'})['project']
    hub.projects.move_room(device, bot, 'room-one', project['id'],
                           {'revision': 1, 'client_id': 'metadata-room-move'},
                           {'members': [{'profile': 'default'}, {'profile': 'other'}]})
    notices = []
    async def broadcast(scope):
        notices.append(scope)
    hub.broadcast_projects = broadcast
    rooms.mutate = lambda *args: {'updated': True}
    response = await signed(client, owner, 'POST', '/api/rooms/room-one/update', {})
    assert response.status == 200, await response.text()
    assert notices == [bot]
    assert hub.projects.snapshot(device, bot)['projects'][0]['revision'] == 2


async def test_room_access_revocation_notifies_member_without_room_metadata(room_http):
    client, hub, rooms = room_http
    owner = await pair_phone(client, hub)
    member = await pair_phone(client, hub, role='member')
    device = hub.store.get_device(owner.id)
    project = hub.projects.create(device, None, {'name': 'Work', 'client_id': 'revocation-project'})['project']
    hub.projects.move_room(device, None, 'room-one', project['id'],
                           {'revision': 1, 'client_id': 'revocation-room-move'},
                           {'members': [{'profile': 'default'}, {'profile': 'other'}]})
    with rooms._db() as db:
        db.execute('UPDATE winglet_rooms SET readers=?', (json.dumps([member.id]),))
    assert len((await (await client.get('/api/project-rooms', headers=member.auth)).json())['rooms']) == 1
    ws = await client.ws_connect('/api/ws')
    await ws.send_json({'type': 'auth', 'token': member.token})
    await ws.receive_json()
    def revoke(*args):
        with rooms._db() as db:
            db.execute("UPDATE winglet_rooms SET readers='[]', title='New secret title'")
        return {'updated': True}
    rooms.mutate = revoke
    response = await signed(client, owner, 'POST', '/api/rooms/room-one/update', {})
    assert response.status == 200, await response.text()
    event = await ws.receive_json(timeout=2)
    assert event['type'] == 'project.sync'
    assert 'Secret room' not in json.dumps(event) and 'New secret title' not in json.dumps(event)
    assert (await (await client.get('/api/project-rooms', headers=member.auth)).json())['rooms'] == []
    await ws.close()


async def test_room_refresh_notification_failure_does_not_fail_saved_update(room_http):
    client, hub, rooms = room_http
    owner = await pair_phone(client, hub)
    device = hub.store.get_device(owner.id)
    project = hub.projects.create(device, None, {'name': 'Work', 'client_id': 'failed-notice-project'})['project']
    hub.projects.move_room(device, None, 'room-one', project['id'],
                           {'revision': 1, 'client_id': 'failed-notice-move'},
                           {'members': [{'profile': 'default'}, {'profile': 'other'}]})
    async def fail(*args):
        raise RuntimeError('notification unavailable')
    hub.broadcast_projects = fail
    rooms.mutate = lambda *args: {'updated': True}
    response = await signed(client, owner, 'POST', '/api/rooms/room-one/update', {})
    assert response.status == 200
    assert await response.json() == {'updated': True}


async def test_project_room_route_grants_archive_and_deletion(room_http):
    client, hub, rooms = room_http
    owner = await pair_phone(client, hub, name='Owner')
    member = await pair_phone(client, hub, name='Member', role='member')
    project = hub.projects.create(hub.store.get_device(owner.id), None,
                                  {'name': 'Work', 'client_id': 'create-work-http'})['project']
    path = '/api/project-rooms/room-one'
    body = {'project_id': project['id'], 'revision': 1, 'client_id': 'move-room-http'}
    assert (await client.post(path, json=body, headers=owner.auth)).status == 403
    assert (await signed(client, member, 'POST', path, body)).status == 403
    response = await signed(client, owner, 'POST', path, body)
    assert response.status == 200, await response.text()
    assert (await signed(client, owner, 'POST', path, body)).status == 200
    assert (await (await client.get('/api/project-rooms', headers=member.auth)).json())['rooms'] == []
    with rooms._db() as db:
        db.execute('UPDATE winglet_rooms SET readers=? WHERE id=?', (json.dumps([member.id]), 'room-one'))
    visible = (await (await client.get('/api/project-rooms', headers=member.auth)).json())['rooms']
    assert visible == [{'id': 'room-one', 'title': 'Secret room', 'project_id': project['id'],
                        'project_bot': None, 'project_revision': 2, 'bot_missing': False}]
    with rooms._db() as db:
        db.execute('UPDATE winglet_rooms SET readers=? WHERE id=?', ('[]', 'room-one'))
    assert (await (await client.get('/api/project-rooms', headers=member.auth)).json())['rooms'] == []
    with rooms._db() as db:
        db.execute('UPDATE winglet_rooms SET members=? WHERE id=?',
                   (json.dumps([{'profile': 'other'}, {'profile': 'third'}]), 'room-one'))
    visible = (await (await client.get('/api/project-rooms', headers=owner.auth)).json())['rooms']
    assert visible[0]['bot_missing'] is True
    with rooms._db() as db:
        db.execute('UPDATE winglet_rooms SET archived=1 WHERE id=?', ('room-one',))
    assert (await (await client.get('/api/project-rooms', headers=owner.auth)).json())['rooms'] == []
    hub.projects.delete(hub.store.get_device(owner.id), None, project['id'],
                        {'revision': 2, 'client_id': 'delete-room-http'})
    with rooms._db() as db:
        assert db.execute('SELECT title FROM winglet_rooms WHERE id=?', ('room-one',)).fetchone()['title'] == 'Secret room'


async def test_cross_bot_links_include_project_coordinates_without_leaking_rooms(room_http):
    client, hub, rooms = room_http
    owner = await pair_phone(client, hub, name='Owner')
    member = await pair_phone(client, hub, name='Member', role='member')
    device = hub.store.get_device(owner.id)
    project = hub.projects.create(device, 'other', {'name': 'Other bot', 'client_id': 'other-bot-create'})['project']
    hub.projects.move_room(device, 'other', 'room-one', project['id'],
                           {'revision': 1, 'client_id': 'other-bot-move'},
                           {'members': [{'profile': 'default'}, {'profile': 'other'}]})
    assert (await (await client.get('/api/project-rooms', headers=member.auth)).json())['rooms'] == []
    with rooms._db() as db:
        db.execute('UPDATE winglet_rooms SET readers=? WHERE id=?', (json.dumps([member.id]), 'room-one'))
    visible = (await (await client.get('/api/project-rooms', headers=member.auth)).json())['rooms']
    assert visible == [{'id': 'room-one', 'title': 'Secret room', 'project_id': project['id'],
                        'project_bot': 'other', 'project_revision': 2, 'bot_missing': False}]


async def test_cross_bot_move_broadcasts_both_project_snapshots(room_http):
    client, hub, _ = room_http
    owner = await pair_phone(client, hub)
    device = hub.store.get_device(owner.id)
    source = hub.projects.create(device, 'other', {'name': 'Other', 'client_id': 'cross-source-create'})['project']
    target = hub.projects.create(device, None, {'name': 'Main', 'client_id': 'cross-target-create'})['project']
    hub.projects.move_room(device, 'other', 'room-one', source['id'],
                           {'revision': 1, 'client_id': 'cross-initial-move'},
                           {'members': [{'profile': 'default'}, {'profile': 'other'}]})
    notices = []
    async def broadcast(bot):
        notices.append(bot)
    hub.broadcast_projects = broadcast
    response = await signed(client, owner, 'POST', '/api/project-rooms/room-one',
                            {'project_id': target['id'], 'revision': 1, 'from_project_id': source['id'],
                             'from_revision': 2, 'client_id': 'cross-second-move'})
    assert response.status == 200, await response.text()
    assert set(notices) == {None, 'other'}
    assert hub.projects.snapshot(device, 'other')['projects'][0]['revision'] == 3


async def test_create_room_with_project_retries_without_duplicate_membership(room_http):
    client, hub, rooms = room_http
    owner = await pair_phone(client, hub)
    project = hub.projects.create(hub.store.get_device(owner.id), None,
                                  {'name': 'Work', 'client_id': 'create-project-room'})['project']
    # Substitute only the Hermes-dependent room creation; project persistence and routes are real.
    rooms.mutate = lambda device, action, room_id, body: {'id': 'room-one'}
    payload = {'title': 'Secret room', 'bots': ['default', 'other'], 'operation_id': 'create-room-operation-1',
               'project_id': project['id'], 'revision': 1}
    first = await signed(client, owner, 'POST', '/api/rooms', payload)
    assert first.status == 200, await first.text()
    assert (await first.json())['filed'] is True
    retry = await signed(client, owner, 'POST', '/api/rooms', payload)
    assert retry.status == 200, await retry.text()
    assert (await retry.json())['filed'] is True
    assert hub.projects.snapshot(hub.store.get_device(owner.id), None)['projects'][0]['revision'] == 2


async def test_create_room_keeps_full_long_derived_id(room_http):
    client, hub, rooms = room_http
    owner = await pair_phone(client, hub)
    project = hub.projects.create(hub.store.get_device(owner.id), None,
                                  {'name': 'Work', 'client_id': 'long-operation-project'})['project']
    rooms.mutate = lambda device, action, room_id, body: {'id': 'room-one'}
    operation = 'x' * 96
    payload = {'operation_id': operation, 'project_id': project['id'], 'revision': 1}
    response = await signed(client, owner, 'POST', '/api/rooms', payload)
    assert (await response.json())['filed'] is True
    assert hub.store._one('SELECT id FROM project_ops WHERE id=?', ('room-file:' + operation,)) is not None
    assert (await (await signed(client, owner, 'POST', '/api/rooms', payload)).json())['filed'] is True


async def test_create_room_preserves_id_when_filing_unexpectedly_fails(room_http, monkeypatch):
    client, hub, rooms = room_http
    owner = await pair_phone(client, hub)
    project = hub.projects.create(hub.store.get_device(owner.id), None,
                                  {'name': 'Work', 'client_id': 'failed-filing-project'})['project']
    rooms.mutate = lambda device, action, room_id, body: {'id': 'room-one'}
    def fail(*args, **kwargs):
        raise RuntimeError('sensitive internal details')
    monkeypatch.setattr(hub.projects, 'move_room', fail)
    response = await signed(client, owner, 'POST', '/api/rooms',
                            {'operation_id': 'failed-filing-operation', 'project_id': project['id'], 'revision': 1})
    result = await response.json()
    assert response.status == 200
    assert result['id'] == 'room-one' and result['filed'] is False
    assert result['file_error'] and 'sensitive' not in result['file_error']


async def test_create_room_reports_filed_when_notifications_fail(room_http, monkeypatch):
    client, hub, rooms = room_http
    owner = await pair_phone(client, hub)
    project = hub.projects.create(hub.store.get_device(owner.id), None,
                                  {'name': 'Work', 'client_id': 'notification-project'})['project']
    rooms.mutate = lambda device, action, room_id, body: {'id': 'room-one'}
    async def failed_broadcast(bot):
        raise RuntimeError('broadcast failed')
    hub.broadcast_projects = failed_broadcast
    def failed_snapshot(*args):
        raise RuntimeError('snapshot failed')
    monkeypatch.setattr(hub.projects, 'snapshot', failed_snapshot)
    response = await signed(client, owner, 'POST', '/api/rooms',
                            {'operation_id': 'notification-operation', 'project_id': project['id'], 'revision': 1})
    assert response.status == 200
    assert (await response.json()) == {'id': 'room-one', 'filed': True}
    assert hub.store._one('SELECT project_id FROM project_rooms WHERE room_id=?', ('room-one',))['project_id'] == project['id']


async def test_create_room_reports_stale_project_without_losing_room(room_http):
    client, hub, rooms = room_http
    owner = await pair_phone(client, hub)
    device = hub.store.get_device(owner.id)
    project = hub.projects.create(device, None, {'name': 'Work', 'client_id': 'create-stale-project'})['project']
    hub.projects.update(device, None, project['id'],
                        {'name': 'New name', 'revision': 1, 'client_id': 'update-before-create'})
    rooms.mutate = lambda device, action, room_id, body: {'id': 'room-one'}
    response = await signed(client, owner, 'POST', '/api/rooms',
                            {'title': 'Secret room', 'bots': ['default', 'other'],
                             'operation_id': 'stale-create-operation', 'project_id': project['id'], 'revision': 1})
    result = await response.json()
    assert response.status == 200
    assert result['id'] == 'room-one' and result['filed'] is False and result['file_error']
    assert result['projects']['projects'][0]['revision'] == 2
    with rooms._db() as db:
        assert rooms._room(db, device, 'room-one')['title'] == 'Secret room'


async def test_stale_removal_returns_conflict_snapshot(room_http):
    client, hub, _ = room_http
    owner = await pair_phone(client, hub)
    project = hub.projects.create(hub.store.get_device(owner.id), None,
                                  {'name': 'Work', 'client_id': 'create-stale-http'})['project']
    path = '/api/project-rooms/room-one'
    assert (await signed(client, owner, 'POST', path,
                         {'project_id': project['id'], 'revision': 1, 'client_id': 'move-stale-http'})).status == 200
    response = await signed(client, owner, 'POST', path,
                            {'from_project_id': project['id'], 'from_revision': 1, 'client_id': 'remove-stale-http'})
    assert response.status == 409
    assert (await response.json())['projects']['projects'][0]['revision'] == 2
    response = await signed(client, owner, 'POST', path,
                            {'from_project_id': project['id'], 'from_revision': 2, 'client_id': 'remove-good-http'})
    assert response.status == 200
    assert (await (await client.get('/api/project-rooms', headers=owner.auth)).json())['rooms'] == []


async def test_a_locked_room_move_is_a_retryable_503(room_http, monkeypatch):
    import sqlite3
    client, hub, _rooms = room_http
    owner = await pair_phone(client, hub)
    device = hub.store.get_device(owner.id)
    project = hub.projects.create(device, None, {"name": "Work", "client_id": "locked-room-project"})["project"]

    def locked(*_args, **_kwargs):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(hub.projects, "move_room", locked)
    response = await signed(client, owner, "POST", "/api/project-rooms/room-one", {"project_id": project["id"]})
    assert response.status == 503
    assert response.headers["Retry-After"] == "1"
    assert "busy" in (await response.json())["error"].lower()
