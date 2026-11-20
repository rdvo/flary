import { useState } from 'react';
import { api, type Role, type Session } from './api';
import styles from './auth.module.css';

type Issued = { address: string; password: string; role: Role };

/** The owner's first stop after setup: add the first people, each with a one-time password to send them. It can be skipped,
 * and People and mailboxes does the same later. */
export function Welcome({ session, onDone }: { session: Session; onDone: () => void }) {
  const domain = session.domain;
  const [person, setPerson] = useState({ address: '', first: '', last: '', role: 'member' as Role }), [issued, setIssued] = useState<Issued[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState('');
  const note = (item: Issued) => [`${session.brand.name} mail`, `Go to: https://${session.host || location.host}`, `Address: ${item.address}`, `Password: ${item.password}`,
    'You will choose your own password the first time you sign in.', ...(item.role !== 'member' ? ['You will also set up two-step sign-in with an authenticator app.'] : [])].join('\n');
  const add = async () => {
    setBusy(true); setError('');
    try {
      const result = await api<{ issued?: Issued }>('/api/org/people', { method: 'POST', body: { address: person.address, name: `${person.first.trim()} ${person.last.trim()}`.trim(), role: person.role } });
      if (result.issued) setIssued([...issued, result.issued]);
      setPerson({ address: '', first: '', last: '', role: 'member' });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'That didn’t work.'); } finally { setBusy(false); }
  };
  const finish = async () => {
    setBusy(true);
    try { await api('/api/welcomed', { method: 'POST' }); onDone(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'That didn’t work.'); setBusy(false); }
  };
  const copy = (item: Issued) => { void navigator.clipboard.writeText(note(item)).then(() => setCopied(item.address)); };

  return <main className={styles.screen}><section className={styles.card}>
    <header><h1>Invite your team</h1></header>
    <p>Each person gets an @{domain} address and a one-time password to sign in with. You can do this later in People and mailboxes.</p>
    {issued.length > 0 && <ul className={styles.steps}>
      {issued.map(item => <li key={item.address} data-ok="true">{item.address}<small>Password, shown once: <code className={styles.secret}>{item.password}</code></small>
        <small><button type="button" className={styles.link} onClick={() => copy(item)}>{copied === item.address ? 'Copied' : 'Copy a note to send them'}</button></small></li>)}
    </ul>}
    <form onSubmit={event => { event.preventDefault(); void add(); }}>
      <div className={styles.pair}>
        <label>First name<input required autoFocus value={person.first} onChange={event => setPerson({ ...person, first: event.target.value })} /></label>
        <label>Last name<input value={person.last} onChange={event => setPerson({ ...person, last: event.target.value })} /></label>
      </div>
      <label>Address<span className={styles.at}><input required value={person.address} onChange={event => setPerson({ ...person, address: event.target.value.trim().toLowerCase().split('@')[0] })} placeholder="name" /><i>@{domain}</i></span></label>
      <label>Role<select value={person.role} onChange={event => setPerson({ ...person, role: event.target.value as Role })}><option value="member">Member: their own mail</option><option value="admin">Admin: can also view People and mailboxes</option></select></label>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <button type="submit" disabled={busy || !person.first.trim() || !person.address}>{busy ? 'Adding…' : issued.length ? 'Add another' : 'Add person'}</button>
      <button type="button" className={styles.plain} disabled={busy} onClick={() => { void finish(); }}>{issued.length ? 'Done, go to mail' : 'Skip for now'}</button>
    </form>
  </section></main>;
}
