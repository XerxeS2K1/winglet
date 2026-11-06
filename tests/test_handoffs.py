"""Offline hand-off admission and durable completion notices; never contact a real bot."""
import asyncio
import json
from types import SimpleNamespace

import pytest

from plugin import teamwork
from plugin.hub import Hub
from plugin.store import Store
from test_teamwork import team  # noqa: F401


@pytest.fixture
async def origin(team, tmp_path, monkeypatch):
    session = pytest.importorskip('gateway.session_context')  # before the adapter import, which needs Hermes's gateway package
    from plugin import adapter
    store = Store(tmp_path / 'winglet.db')
    hub = Hub(store, web_root=tmp_path / 'web')
    chat = store.create_chat('Jobs')
    env = {'HERMES_SESSION_PLATFORM': 'winglet', 'HERMES_SESSION_CHAT_ID': chat['id']}
    monkeypatch.setattr(session, 'get_session_env', lambda key, default='': env.get(key, default))
    monkeypatch.setattr(adapter, '_ACTIVE', SimpleNamespace(_hub=hub, _loop=asyncio.get_running_loop()))
    yield hub, store, chat
    await hub.aclose()
    store.close()


async def test_pending_handoff_returns_without_resending_and_posts_one_finished_notice(origin, monkeypatch):
    hub, store, chat = origin
    sent = []
    def deliver(profile, content, sender, **options):
        row = store._one('SELECT * FROM handoffs WHERE delivery_id=?', (options['delivery_id'],))
        assert row is not None and row['state'] == 'inline'  # durable before target can observe it
        sent.append((profile, options))
        return {'status': 'claimed'}
    monkeypatch.setattr(teamwork, '_deliver', deliver)
    result = json.loads(await asyncio.to_thread(teamwork.ask_bot, {'bot': 'chef', 'message': 'Plan dinner', 'wait': 0}))
    assert result.get('status') == 'queued'
    delivery_id = result['delivery_id']
    assert sent == [('chef', {'delivery_id': delivery_id, 'wait_seconds': 0})]
    assert 'do not resend' in result['note'].lower()
    hub.handoffs.read_receipt = lambda profile, key: {'status': 'settled', 'reply': 'Pasta on Tuesday.'}
    await hub.handoffs.sweep()
    await hub.handoffs.sweep()
    notes = [m for m in store.list_messages(chat['id']) if m['meta'].get('asked')]
    assert len(notes) == 1
    assert notes[0]['text'] == 'Chef finished the handed-off task.'
    assert notes[0]['role'] == 'bot'
    assert notes[0]['meta']['asked']['answer'] == 'Pasta on Tuesday.'
    assert notes[0]['meta']['asked']['delivery_id'] == delivery_id
    assert hub._notifiable(notes[0])
    assert len(sent) == 1


async def test_inline_answers_do_not_get_a_second_finished_notice(origin):
    hub, store, chat = origin
    result = json.loads(await asyncio.to_thread(teamwork.ask_bot, {'bot': 'chef', 'message': 'Dinner?'}))
    assert result['reply'] == 'Pasta on Tuesday.'
    await asyncio.sleep(0.05)
    await hub.handoffs.sweep()
    assert store.pending_handoffs() == []
    assert not [m for m in store.list_messages(chat['id']) if m['role'] == 'bot']


@pytest.mark.parametrize('wait', [-1, 401, True, '60', float('nan'), float('inf')])
async def test_invalid_wait_never_admits_a_task(origin, team, wait):
    result = json.loads(await asyncio.to_thread(teamwork.ask_bot, {'bot': 'chef', 'message': 'Dinner?', 'wait': wait}))
    assert 'wait must' in result['error']
    assert team.sent == []


async def test_failed_ledger_write_prevents_admission(origin, team, monkeypatch):
    hub, store, _ = origin
    def broken(*args):
        raise OSError('disk unavailable')
    monkeypatch.setattr(store, 'register_handoff', broken)
    result = json.loads(await asyncio.to_thread(teamwork.ask_bot, {'bot': 'chef', 'message': 'Dinner?'}))
    assert 'nothing was sent' in result['error']
    assert team.sent == []


@pytest.mark.parametrize('status', ['failed', 'cancelled', 'ambiguous', 'settled'])
async def test_restart_recovers_unfinished_inline_record_without_duplicate_notice(origin, status):
    hub, store, chat = origin
    key = 'a' * 32
    store.register_handoff(key, chat['id'], 'chef', 'Chef', 'Dinner?', -100)
    # A new service/store sees the persisted record after an interrupted inline wait.
    recovered_store = Store(store.path)
    recovered = Hub(recovered_store)
    recovered.handoffs.read_receipt = lambda *args: {'status': status, 'reply': ''}
    try:
        await recovered.handoffs.sweep()
        await recovered.handoffs.sweep()
        notes = store.list_messages(chat['id'])
        assert len(notes) == 1
        assert notes[0]['meta']['asked']['failed'] is True
        assert 'without a confirmed answer' in notes[0]['text']
        assert store.pending_handoffs() == []
    finally:
        await recovered.aclose()
        recovered_store.close()


async def test_missing_receipt_does_not_fail_or_resend_and_deleted_chat_is_not_recreated(origin):
    hub, store, chat = origin
    store.register_handoff('b' * 32, chat['id'], 'chef', 'Chef', 'Dinner?', 0)
    store.handoff_state('b' * 32, 'waiting')
    hub.handoffs.read_receipt = lambda *args: None
    await hub.handoffs.sweep()
    assert len(store.pending_handoffs()) == 1
    assert store.list_messages(chat['id']) == []
    store.delete_chat(chat['id'])
    hub.handoffs.read_receipt = lambda *args: {'status': 'settled', 'reply': 'Private answer'}
    await hub.handoffs.sweep()
    assert store.get_chat(chat['id']) is None
    assert store.pending_handoffs() == []


async def test_notice_text_never_contains_private_reply(origin):
    hub, store, chat = origin
    store.register_handoff('c' * 32, chat['id'], 'chef', 'Chef', 'Private question', 0)
    store.handoff_state('c' * 32, 'waiting')
    hub.handoffs.read_receipt = lambda *args: {'status': 'settled', 'reply': 'Private answer'}
    pushes = []
    hub.schedule_push = lambda *args, **kw: pushes.append((args, kw))
    await hub.handoffs.sweep()
    message = store.list_messages(chat['id'])[0]
    assert 'Private' not in message['text']
    assert message['meta']['asked']['answer'] == 'Private answer'
    assert pushes == [((chat['id'], message['id']), {'final': True})]
