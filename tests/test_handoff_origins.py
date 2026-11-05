import asyncio
import json

from plugin import teamwork
from test_handoffs import origin, team  # noqa: F401


async def test_both_origin_notes_exist_before_admission_and_finish_in_place(origin, monkeypatch):
    hub, store, chat = origin
    def deliver(profile, content, sender, **options):
        source = store.get_message('handoff-' + options['delivery_id'])
        assert source is not None, 'the asking chat needs a trace before admission'
        assert source['meta']['asked']['state'] == 'queued'
        target = store.get_message('handoff-target-' + options['delivery_id'])
        assert target is not None
        assert store.get_chat(target['chat_id'])['bot'] == 'chef'
        assert 'Task from Hermes' in target['text']
        assert 'Jobs' in target['text'] and 'Plan dinner' in target['text']
        assert target['meta']['notify'] is False
        return {'status': 'claimed'}
    monkeypatch.setattr(teamwork, '_deliver', deliver)
    result = json.loads(await asyncio.to_thread(teamwork.ask_bot, {'bot': 'chef', 'message': 'Plan dinner', 'wait': 0}))
    assert result.get('status') == 'queued', result
    hub.handoffs.read_receipt = lambda *args: {'status': 'settled', 'reply': 'Private dinner answer'}
    await hub.handoffs.sweep()
    rows = store.list_messages(chat['id'])
    assert len(rows) == 1
    assert rows[0]['meta']['asked']['state'] == 'answered'
    target = store.get_message('handoff-target-' + result['delivery_id'])
    assert 'Finished' in target['text']
    assert 'Private dinner answer' not in target['text']
    assert target['meta']['notify'] is False


async def test_inline_origin_notes_are_quiet_and_do_not_duplicate_the_asking_row(origin):
    hub, store, chat = origin
    result = json.loads(await asyncio.to_thread(teamwork.ask_bot, {'bot': 'chef', 'message': 'Dinner?'}))
    assert result['reply'] == 'Pasta on Tuesday.'
    notes = store.list_messages(chat['id'])
    assert len(notes) == 1
    assert notes[0]['text'] == 'Asked Chef'
    assert notes[0]['role'] == 'system' and notes[0]['meta']['notify'] is False
    target = store.list_messages('b-chef')
    assert len(target) == 1 and 'Finished' in target[0]['text']
    assert not hub.can_see({'role': 'member', 'id': 'unrelated'}, store.get_chat('b-chef'))


async def test_secondary_asker_leaves_target_note_in_main_bot_not_its_own_scope(origin, team):
    hub, store, chat = origin
    team.me = 'chef'
    store._exec('UPDATE chats SET bot=? WHERE id=?', ('chef', chat['id']))
    result = json.loads(await asyncio.to_thread(teamwork.ask_bot, {'bot': 'hermes', 'message': 'Help?'}))
    assert result['reply']
    target = store.list_messages('general')
    assert len(target) == 1
    assert 'Task from Chef' in target[0]['text']
    assert store.get_chat('general')['bot'] is None


async def test_target_note_is_not_recreated_after_its_chat_was_deleted(origin):
    hub, store, chat = origin
    store.ensure_chat('b-chef', 'Chef', bot='chef')
    store.delete_chat('b-chef')
    store.register_handoff('d' * 32, chat['id'], 'chef', 'Chef', 'Help?', 0)
    await hub.handoffs.begin('d' * 32, 'Hermes')
    assert store.get_chat('b-chef') is None
    assert store.get_message('handoff-target-' + 'd' * 32) is None
    assert store.get_message('handoff-' + 'd' * 32) is not None
