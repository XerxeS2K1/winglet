"""Review finding #29: creating a room into a project must not run the project snapshot on the event loop."""
import json
import threading

from plugin import rooms_routes
from test_rooms_routes import client, hub  # noqa: F401  (fixtures)
from test_trust import pair_phone


async def test_the_project_snapshot_after_creating_a_room_runs_off_the_event_loop(client, hub, monkeypatch):
    loop_thread = threading.get_ident()
    ran_on = []
    hub.rooms.mutate = lambda device, action, room_id, body: {"id": "room-1"}
    hub.rooms._actor = lambda device, owner=False: device
    monkeypatch.setattr(rooms_routes, "_file_created_room", lambda *args: {"filed": True})

    async def no_broadcast(bot):
        pass
    hub.broadcast_projects = no_broadcast

    def snapshot(device, bot):
        ran_on.append(threading.get_ident())
        return {"projects": [], "threads": []}
    hub.projects.snapshot = snapshot

    phone = await pair_phone(client, hub)
    body = json.dumps({"operation_id": "test-operation-123", "title": "Plans", "project_id": "p1"}).encode()
    signed = phone.signed("POST", "/api/rooms", body)
    response = await client.post("/api/rooms", headers={**signed, "Content-Type": "application/json"}, data=body)
    assert response.status == 200, await response.text()
    answer = await response.json()
    assert answer["filed"] is True and answer["projects"] == {"projects": [], "threads": []}
    assert ran_on and loop_thread not in ran_on
