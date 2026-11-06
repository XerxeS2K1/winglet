import { botQueueRows } from '../lib/bots';
import { useApp } from '../lib/store';
import type { Server } from '../lib/types';
import { Sheet } from './Sheet';
import { Footnote, ListGroup, ListRow } from './ui';

/** Owner-only, transient server data. This view never admits, cancels or reorders work. */
export function QueueSheet({ server, onClose }: { server?: Server; onClose: () => void }) {
  const rt = useApp((st) => server ? st.runtime[server.id] : undefined);
  const network = useApp((st) => st.network);
  const activity = network && rt?.status === 'online' && server?.bot.served !== false
    ? rt.botActivity?.[server?.profile ?? 'default'] : undefined;
  const rows = botQueueRows(activity);
  return <Sheet visible={!!server} onClose={onClose} title={`${server?.bot.title ?? 'Bot'} queue`} scrollable>
    <Footnote>Read-only. Hand-offs run in queue order. Chats and other work are not listed here.</Footnote>
    {rows === undefined ? <Footnote>Queue details unavailable. Reconnect or update the server to see the queue.</Footnote>
      : rows.length === 0 ? <Footnote>No queued or running hand-offs.</Footnote>
      : <ListGroup>{rows.map((row) => <ListRow key={row.id} title={row.title} subtitle={row.subtitle} value={row.value} chevron={false} />)}</ListGroup>}
    {activity?.state === 'unknown' && rows !== undefined ? <Footnote>Live activity is unavailable; started tasks are unconfirmed.</Footnote> : null}
    {activity?.queue_truncated ? <Footnote>Showing the first 50 hand-offs. More are waiting behind them.</Footnote> : null}
  </Sheet>;
}
