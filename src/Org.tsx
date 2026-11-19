import { useEffect, useState } from 'react';
import { ArrowLeftIcon, SignOutIcon, XIcon } from '@phosphor-icons/react';
import product from '../product.json';
import { api, navigate, type Role, type Session } from './api';
import { Health } from './Health';
import styles from './org.module.css';

type Person = { id: string; name: string; role: Role; address: string; mailboxId: string; waiting: boolean; twoStep: boolean; createdAt: number };
type Box = { id: string; address: string; name: string; kind: 'personal' | 'shared'; accountId: string | null; members: string[]; aliases: string[] };
type Snapshot = { domain: string; people: Person[]; mailboxes: Box[]; issued?: { address: string; password: string; role: Role } };

const ROLE: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };
const tint = (name: string) => `hsl(${[...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7)} 42% 46%)`;
const initial = (name: string) => (name.trim()[0] || '?').toUpperCase();
const local = (value: string) => value.trim().toLowerCase().split('@')[0];

/** The org panel: who can sign in, and which addresses deliver where. The owner changes it; admins can look. */
export function Org({ session }: { session: Session }) {
  const owner = session.account!.role === 'owner', domain = session.domain;
  const [org, setOrg] = useState<Snapshot | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [issued, setIssued] = useState<Snapshot['issued'] | null>(null), [copied, setCopied] = useState(false), [editing, setEditing] = useState<{ id: string; name: string; role: Role } | null>(null);
  const [person, setPerson] = useState({ address: '', name: '', role: 'member' as Role }), [shared, setShared] = useState({ address: '', name: '' }), [alias, setAlias] = useState<Record<string, string>>({});
  useEffect(() => { document.title = `People and mailboxes · ${product.name}`; }, []);
  const run = async (work: Promise<Snapshot>) => {
    setBusy(true); setError('');
    try { const result = await work; setOrg(result); if (result.issued) { setIssued(result.issued); setCopied(false); } return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'That didn’t work.'); return false; }
    finally { setBusy(false); }
  };
  useEffect(() => { void run(api<Snapshot>('/api/org')); }, []);
  const call = (path: string, method: string, body?: unknown) => run(api<Snapshot>(`/api/org/${path}`, { method, body }));
  const nameOf = (id: string) => org?.people.find(item => item.id === id)?.name ?? 'Someone removed';
  const note = issued ? [`${product.name} sign-in`, `Go to: ${location.origin}`, `Address: ${issued.address}`, `Password: ${issued.password}`,
    'You will choose your own password the first time you sign in.', ...(issued.role !== 'member' ? ['You will also set up two-step sign-in with an authenticator app.'] : [])].join('\n') : '';
  const signOut = () => { void api('/api/auth/signout', { method: 'POST' }).finally(() => location.assign('/')); };

  return <div className={styles.page}>
    <header className={styles.top}>
      <button type="button" className={styles.back} onClick={() => navigate('/')}><ArrowLeftIcon size={18} />Mail</button>
      <span className="wordmark">{product.name}</span>
      <span className={styles.gap} />
      <span className={styles.domain}>{domain}</span>
      <button type="button" className={styles.icon} aria-label="Sign out" title="Sign out" onClick={signOut}><SignOutIcon size={18} /></button>
    </header>
    <main className={styles.column}>
      <h1>People and mailboxes</h1>
      {!owner && <p className={styles.lead}>You can view this as an admin. Only the owner can change it.</p>}
      {error && <p role="alert" className={styles.error}>{error}<button type="button" aria-label="Dismiss" onClick={() => setError('')}><XIcon size={13} /></button></p>}

      <section className={styles.section}>
        <div className={styles.head}><h2>People</h2><p>Each person signs in with their own address and reads only their own mail, plus any shared mailboxes they are in. Owners and admins must use two-step sign-in.</p></div>
        <div className={styles.body}>
          {issued && <div className={styles.issued} role="status"><strong>Send this to {issued.address}. It is shown only once.</strong><pre>{note}</pre>
            <div><button type="button" onClick={() => { void navigator.clipboard.writeText(note).then(() => setCopied(true)); }}>{copied ? 'Copied' : 'Copy'}</button>
              <button type="button" className={styles.quiet} onClick={() => setIssued(null)}>Done</button></div></div>}
          <ul className={styles.list}>
            {org?.people.map(item => editing?.id === item.id
              ? <li key={item.id}><form className={styles.inlineForm} onSubmit={event => { event.preventDefault(); void call(`people/${item.id}`, 'PATCH', item.role === 'owner' ? { name: editing.name } : { name: editing.name, role: editing.role }).then(ok => { if (ok) setEditing(null); }); }}>
                  <input required value={editing.name} aria-label="Name" onChange={event => setEditing({ ...editing, name: event.target.value })} />
                  {item.role !== 'owner' && <select value={editing.role} aria-label="Role" onChange={event => setEditing({ ...editing, role: event.target.value as Role })}><option value="member">Member</option><option value="admin">Admin</option></select>}
                  <button type="submit" disabled={busy}>Save</button><button type="button" className={styles.quiet} onClick={() => setEditing(null)}>Cancel</button></form></li>
              : <li key={item.id}>
                  <span className={styles.face} style={{ background: tint(item.address) }}>{initial(item.name)}</span>
                  <div className={styles.who}><strong>{item.name}<span className={styles.badge} data-role={item.role}>{ROLE[item.role]}</span></strong><span>{item.address}</span>
                    <small>{item.waiting ? 'Has not signed in yet' : item.twoStep ? 'Two-step sign-in on' : 'Signed in before'}</small></div>
                  {owner && <div className={styles.actions}>
                    <button type="button" disabled={busy} onClick={() => setEditing({ id: item.id, name: item.name, role: item.role })}>Change</button>
                    {item.role !== 'owner' && <>
                      <button type="button" disabled={busy} onClick={() => { if (confirm(`Start ${item.address} over? They are signed out and get a new one-time password${item.twoStep ? ', and set up two-step sign-in again' : ''}.`)) void call(`people/${item.id}/reset`, 'POST'); }}>Reset</button>
                      <button type="button" disabled={busy} onClick={() => { if (confirm(`Remove ${item.name}? They are signed out. Their mailbox and its mail stay, and you can give someone access to it.`)) void call(`people/${item.id}`, 'DELETE'); }}>Remove</button>
                    </>}
                  </div>}
                </li>)}
            {!org && <li className={styles.empty}>Loading…</li>}
          </ul>
          {owner && <form className={styles.form} onSubmit={event => { event.preventDefault(); void call('people', 'POST', person).then(ok => { if (ok) setPerson({ address: '', name: '', role: 'member' }); }); }}>
            <h3>Add a person</h3>
            <label>Address<span className={styles.at}><input required value={person.address} onChange={event => setPerson({ ...person, address: local(event.target.value) })} placeholder="name" /><i>@{domain}</i></span></label>
            <label>Name on their mail<input required value={person.name} onChange={event => setPerson({ ...person, name: event.target.value })} placeholder="First and last name" /></label>
            <label>Role<select value={person.role} onChange={event => setPerson({ ...person, role: event.target.value as Role })}><option value="member">Member: their own mail</option><option value="admin">Admin: also views this page, needs two-step sign-in</option></select></label>
            <button type="submit" disabled={busy || !person.address || !person.name}>{busy ? 'Saving…' : 'Add person'}</button>
          </form>}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.head}><h2>Mailboxes</h2><p>Every address that receives mail. A shared mailbox is read and answered by its members, and mail sent from it comes from its address. An alias is an extra address that delivers into a mailbox. Mail to any other address on {domain} is refused.</p></div>
        <div className={styles.body}>
          <ul className={styles.list}>
            {org?.mailboxes.map(box => { const free = !box.accountId, others = org.people.filter(item => !box.members.includes(item.id));
              return <li key={box.id} className={styles.box}>
                <div className={styles.boxTop}>
                  <span className={styles.face} style={{ background: tint(box.address) }}>{initial(box.name)}</span>
                  <div className={styles.who}><strong>{box.name}</strong><span>{box.address}</span>
                    <small>{box.accountId ? `${nameOf(box.accountId)}’s own mailbox` : box.kind === 'shared' ? 'Shared mailbox' : 'Its person was removed; the mail is kept'}</small></div>
                  {owner && free && <div className={styles.actions}>
                    <button type="button" disabled={busy} onClick={() => { const name = prompt('Mailbox name', box.name); if (name?.trim()) void call(`mailboxes/${box.id}`, 'PATCH', { name }); }}>Rename</button>
                    <button type="button" disabled={busy} onClick={() => { if (confirm(`Delete ${box.address} and all of its mail? This can’t be undone.`)) void call(`mailboxes/${box.id}`, 'DELETE'); }}>Delete</button>
                  </div>}
                </div>
                {free && <div className={styles.chips}><span className={styles.label}>Members</span>
                  {box.members.map(id => <span key={id} className={styles.chip}>{nameOf(id)}{owner && <button type="button" aria-label={`Remove ${nameOf(id)}`} disabled={busy} onClick={() => { void call(`mailboxes/${box.id}/members/${id}`, 'DELETE'); }}><XIcon size={11} /></button>}</span>)}
                  {!box.members.length && <span className={styles.none}>Nobody can read this yet</span>}
                  {owner && others.length > 0 && <select className={styles.add} value="" disabled={busy} aria-label="Add a member" onChange={event => { if (event.target.value) void call(`mailboxes/${box.id}/members/${event.target.value}`, 'PUT'); }}>
                    <option value="">Add a member…</option>{others.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
                </div>}
                <div className={styles.chips}><span className={styles.label}>Aliases</span>
                  {box.aliases.map(address => <span key={address} className={styles.chip}>{address}{owner && <button type="button" aria-label={`Remove ${address}`} disabled={busy} onClick={() => { void call(`aliases/${encodeURIComponent(address)}`, 'DELETE'); }}><XIcon size={11} /></button>}</span>)}
                  {!box.aliases.length && !owner && <span className={styles.none}>None</span>}
                  {owner && <form className={styles.aliasForm} onSubmit={event => { event.preventDefault(); void call('aliases', 'POST', { address: alias[box.id], mailboxId: box.id }).then(ok => { if (ok) setAlias({ ...alias, [box.id]: '' }); }); }}>
                    <input value={alias[box.id] || ''} aria-label={`New alias for ${box.address}`} placeholder="add alias" onChange={event => setAlias({ ...alias, [box.id]: local(event.target.value) })} /><i>@{domain}</i>
                    {alias[box.id] && <button type="submit" disabled={busy}>Add</button>}</form>}
                </div>
              </li>; })}
          </ul>
          {owner && <form className={styles.form} onSubmit={event => { event.preventDefault(); void call('mailboxes', 'POST', shared).then(ok => { if (ok) setShared({ address: '', name: '' }); }); }}>
            <h3>New shared mailbox</h3>
            <label>Address<span className={styles.at}><input required value={shared.address} onChange={event => setShared({ ...shared, address: local(event.target.value) })} placeholder="support" /><i>@{domain}</i></span></label>
            <label>Name mail is sent under<input required value={shared.name} onChange={event => setShared({ ...shared, name: event.target.value })} placeholder="Support" /></label>
            <p className={styles.hint}>You are added as its first member. Add others above once it exists.</p>
            <button type="submit" disabled={busy || !shared.address || !shared.name}>{busy ? 'Saving…' : 'Create mailbox'}</button>
          </form>}
        </div>
      </section>

      {owner && <Health domain={domain} />}
    </main>
  </div>;
}
