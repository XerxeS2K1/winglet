import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { homeChat, useApp } from '../../lib/store';

/**
 * The Connection screen is now the "Reaching it" part of the Server screen. Old links, the About bot cards and the
 * connection banner's Details still land here: pick that bot, then go to /server. An unknown id goes home as before.
 */
export default function ConnectionRedirect() {
  const { serverId } = useLocalSearchParams<{ serverId: string }>();
  const known = useApp((st) => st.servers.some((x) => x.id === serverId));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const app = useApp.getState();
    if (known && app.selection.serverId !== serverId) app.select(serverId, homeChat(app.runtime[serverId]));
    setReady(true);
  }, [known, serverId]);
  if (!known) return <Redirect href="/" />;
  return ready ? <Redirect href="/server" /> : null;
}
