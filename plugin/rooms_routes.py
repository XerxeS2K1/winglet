"""Paired scoped reads and signed room controls; no generic RPC proxy."""
import asyncio
import json
import logging
from aiohttp import web
from .projects import ProjectError
from .rooms import RoomError

logger=logging.getLogger(__name__)


def _file_created_room(hub, device, bot, room_id, body):
    # Room creation and project storage use separate databases. A failed filing
    # must preserve the created room and can be retried with the same identity.
    operation = body['operation_id']
    key = 'room-file:' + operation
    device = hub.rooms._actor(device, owner=True)
    with hub.rooms._db() as db:
        db.execute('BEGIN IMMEDIATE')
        try:
            row = hub.rooms._room(db, device, room_id)
            room = {**row, 'members': json.loads(row['members'])}
            return hub.projects.move_room(device, bot, room_id, body['project_id'],
                                          {'revision': body.get('revision'), 'client_id': key}, room,
                                          client_id_max=len('room-file:') + 96)
        finally:
            db.rollback()


async def _run(request, kind):
    hub=request.app['hub']
    device=hub._require(request)
    if hub.rooms is None:
        return web.json_response({'error':'Rooms are unavailable on this Hermes.'},status=409)
    room_id=request.match_info.get('room_id','')
    try:
        if kind=='list':
            result=await asyncio.to_thread(hub.rooms.listing,device)
        elif kind=='state':
            result=await asyncio.to_thread(hub.rooms.state,device,room_id)
        elif kind=='log':
            result=await asyncio.to_thread(hub.rooms.log,device,room_id,
                None if request.query.get('tail')=='1' else request.query.get('epoch','0'),request.query.get('after','0'))
        else:
            try: body=await request.json()
            except Exception: raise RoomError('Expected a JSON object.',400)
            if not isinstance(body,dict): raise RoomError('Expected a JSON object.',400)
            action='create' if kind=='create' else request.match_info['action']
            if kind == 'create' and body.get('project_id') is not None and not isinstance(body['project_id'], str):
                raise RoomError('Invalid project.', 400)
            result=await asyncio.to_thread(hub.rooms.mutate,device,action,room_id,body)
            if action == 'update':
                # Title, roster, archive and reader changes affect the project room list
                # without changing a project's revision. Invalidate it through the same
                # per-device snapshot channel as room moves, in its owning bot scope.
                try:
                    link = hub.store._one('SELECT p.bot FROM project_rooms pr '
                                          'JOIN projects p ON p.id=pr.project_id WHERE pr.room_id=?', (room_id,))
                    if link:
                        await hub.broadcast_projects(link['bot'] or None)
                except Exception:
                    logger.exception('[winglet] could not broadcast room metadata changes')
            if kind == 'create' and body.get('project_id'):
                from .hub import _BOT
                bot = _BOT.get()
                try:
                    await asyncio.to_thread(_file_created_room, hub, device, bot, result['id'], body)
                    result = {**result, 'filed': True}
                except (ProjectError, RoomError) as exc:
                    result = {**result, 'filed': False, 'file_error': str(exc)}
                except Exception:
                    logger.error('[winglet] could not file the newly created room')
                    result = {**result, 'filed': False,
                              'file_error': 'Could not file the room. Reload projects and try again.'}
                device = hub.rooms._actor(device, owner=True)
                if result['filed']:
                    try:
                        await hub.broadcast_projects(bot)
                    except Exception:
                        logger.error('[winglet] could not broadcast project changes')
                try:
                    result['projects'] = await asyncio.to_thread(hub.projects.snapshot, device, bot)
                except Exception:
                    logger.error('[winglet] could not load project snapshot')
        return web.json_response(result)
    except RoomError as exc:
        return web.json_response({'error':str(exc)},status=exc.status)
    except ValueError as exc:
        return web.json_response({'error':str(exc)},status=409)
    except Exception:
        logger.exception('[winglet] room %s failed',kind)
        return web.json_response({'error':'Could not complete the room operation. Reload to check its state.'},status=502)


async def h_rooms(request): return await _run(request,'list')
async def h_room_create(request): return await _run(request,'create')
async def h_room_state(request): return await _run(request,'state')
async def h_room_log(request): return await _run(request,'log')
async def h_room_action(request): return await _run(request,'action')


def register_routes(app):
    app.router.add_get('/api/rooms',h_rooms)
    app.router.add_post('/api/rooms',h_room_create)
    app.router.add_get('/api/rooms/{room_id}',h_room_state)
    app.router.add_get('/api/rooms/{room_id}/log',h_room_log)
    app.router.add_post('/api/rooms/{room_id}/{action}',h_room_action)
