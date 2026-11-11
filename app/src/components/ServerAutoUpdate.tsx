import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { CircleArrowUp } from './icons';
import { Footnote, ListGroup, ListRow, Toggle } from './ui';
import { api, signedApi } from '../lib/api';
import { useApp } from '../lib/store';
import { makeStyles, useTheme } from '../lib/themeContext';

/**
 * Owner-only setting. The server reads this itself; the phone writes it and otherwise leaves the
 * server alone. Members do not see the switch because the server would refuse the write.
 */
export function ServerAutoUpdateCard() {
  const t = useTheme();
  const s = useStyles();
  const server = useApp((st) => st.servers.find((item) => item.id === st.selection.serverId) ?? st.servers[0]);
  const owner = useApp((st) => (server ? st.runtime[server.id]?.me?.role === 'owner' : false));
  const [value, setValue] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!server || !owner) return;
    let alive = true;
    setValue(null);
    setError('');
    api<{ autoUpdate: boolean }>(server, '/api/settings')
      .then((next) => { if (alive) setValue(next.autoUpdate); })
      .catch((e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [server?.id, server?.url, owner]);
  if (!server || !owner) return null;
  const change = async (on: boolean) => {
    const before = value;
    setValue(on);
    setSaving(true);
    setError('');
    try {
      const next = await signedApi<{ autoUpdate: boolean }>(server, 'PUT', '/api/settings', { autoUpdate: on });
      setValue(next.autoUpdate);
    } catch (e) {
      setValue(before);
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <ListGroup>
        <ListRow icon={<CircleArrowUp size={18} color={t.colors.textSecondary} />} title="Update automatically"
          value={value === null ? 'Loading…' : value ? 'On' : 'Off'}
          right={value === null ? <Text style={s.note}>Loading…</Text>
            : <Toggle label="Update the server plugin automatically" value={value}
              onValueChange={(on) => { if (!saving) void change(on); }} />} />
      </ListGroup>
      <Footnote>Winglet updates the server plugin by itself when no chat or job is busy. It uses the same backup and rollback as a manual update; the phone is only showing the setting.</Footnote>
      {error ? <Text style={s.warn} accessibilityRole="alert">{error}</Text> : null}
    </>
  );
}

const useStyles = makeStyles((t) => ({
  note: { ...t.type.callout, color: t.colors.textSecondary },
  warn: { ...t.type.callout, color: t.colors.warning },
}));
