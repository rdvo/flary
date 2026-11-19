import { useEffect, useState } from 'react';
import { SIGNED_OUT, api, navigate, useData, type Session } from './api';
import { ChangePassword, SignIn } from './Auth';
import { Setup } from './Setup';
import { Mail } from './Mail';
import { Org } from './Org';

const BOX = 'mailbox';

export function App() {
  const session = useData(() => api<Session>('/api/session'), [], 60_000);
  const [path, setPath] = useState(location.pathname), [justMade, setJustMade] = useState('');
  const [chosen, setChosen] = useState(() => { try { return localStorage.getItem(BOX) || ''; } catch { return ''; } });
  useEffect(() => {
    const moved = () => setPath(location.pathname), ended = () => { void session.reload(); };
    addEventListener('popstate', moved); addEventListener(SIGNED_OUT, ended);
    return () => { removeEventListener('popstate', moved); removeEventListener(SIGNED_OUT, ended); };
  }, [session.reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const data = session.data;
  if (!data) return session.error ? <p style={{ padding: 24, color: 'var(--red)' }}>{session.error}</p> : null;
  if (data.setup) return <Setup domain={data.domain} onDone={address => { setJustMade(address); void session.reload(); }} />;
  if (!data.account) return <SignIn domain={data.domain} address={justMade} onDone={() => { void session.reload(); }} />;

  if (path === '/org' && data.account.role !== 'member') return <Org session={data} />;
  if (path === '/password') return <ChangePassword address={data.account.address} onBack={() => navigate('/')} />;
  const box = data.mailboxes.find(item => item.id === chosen) ?? data.mailboxes[0];
  if (!box) return <p style={{ padding: 24 }}>You have no mailbox. Ask the owner.</p>;
  const pick = (id: string) => { setChosen(id); try { localStorage.setItem(BOX, id); } catch { /* Private mode: the pick lasts for this page. */ } };
  return <Mail key={box.id} session={data} box={box} onBox={pick} onCounts={() => { void session.reload(); }} />;
}
