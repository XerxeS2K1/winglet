import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef } from 'react';
import { ChatView } from '../../../components/ChatView';
import { PERF_ON, perfNavStart } from '../../../lib/perf';
import { useApp } from '../../../lib/store';

export default function ChatScreen() {
  const { serverId, chatId } = useLocalSearchParams<{ serverId: string; chatId: string }>();
  const server = useApp((s) => s.servers.find((x) => x.id === serverId));
  useEffect(() => { if (server) useApp.getState().select(server.id, chatId); }, [server?.id, chatId]);
  // Opened without a tap on a row (back, a notification, a link): the route is the start. A tap already started it.
  const started = useRef('');
  if (PERF_ON && server && started.current !== `${serverId}:${chatId}`) {
    started.current = `${serverId}:${chatId}`;
    perfNavStart('chat', started.current);
  }
  if (!server) return <Redirect href="/" />;
  return <ChatView server={server} chatId={chatId} showBack />;
}
