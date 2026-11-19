import { useState } from 'react';
import product from '../product.json';
import { tokenLink } from '../shared/cloudflare.mjs';
import type { Session } from './api';
import { post } from './Auth';
import { Redirect, type Failed, type StepKey } from './Setup';
import styles from './org.module.css';
import auth from './auth.module.css';

type Item = { key: StepKey; ok: boolean; label: string; detail?: string; fix?: string };
type Report = { host?: string; items?: Item[]; failed?: Failed; confirm?: string[] };

/** The owner's Setup health: is mail coming in and going out, with the plain fix for anything red. It uses the Cloudflare
 * token kept at setup; a new one can be pasted, and replaces it. */
export function Health({ session }: { session: Session }) {
  const domain = session.domain;
  const [cfToken, setCfToken] = useState(''), [another, setAnother] = useState(!session.cloudflare);
  const [host, setHost] = useState(() => session.host || (location.hostname.endsWith('.workers.dev') ? `mail.${domain}` : location.hostname));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [report, setReport] = useState<Report | null>(null);
  const [confirm, setConfirm] = useState<string[] | null>(null), [typed, setTyped] = useState('');
  const run = async (fix: boolean) => {
    setBusy(true); setError('');
    try {
      const { ok, status, result } = await post<Report>('/api/health', { cfToken, host, fix, confirmed: typed });
      if (status === 409 && result.confirm) { setConfirm(result.confirm); return; }
      if (!ok) { setError(result.error || 'That didn’t work.'); return; }
      setReport(result); setConfirm(null); setTyped('');
    } catch { setError('Could not reach the server. Try again.'); } finally { setBusy(false); }
  };
  const red = report?.items?.filter(item => !item.ok) ?? [];
  const ready = !busy && (!another || Boolean(cfToken));
  return <section className={styles.section}>
    <div className={styles.head}><h2>Setup health</h2><p>Whether mail for {domain} comes in here and can go out, and whether your web address works. Fix sets right whatever is red.</p></div>
    <div className={styles.body}>
      {report?.items && <ul className={auth.steps}>
        {report.items.map(item => <li key={`${item.key}${item.label}`} data-ok={item.ok}>{item.label}{item.detail && <small>{item.detail}</small>}{!item.ok && item.fix && <small><b>To fix:</b> {item.fix}</small>}</li>)}
      </ul>}
      {report?.failed && <p role="alert" className={styles.error}>{report.failed.problem} To fix: {report.failed.fix}</p>}
      {confirm && <Redirect domain={domain} places={confirm} value={typed} onChange={setTyped} />}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <form className={styles.form} onSubmit={event => { event.preventDefault(); void run(false); }}>
        <label>Web address<input required value={host} onChange={event => setHost(event.target.value.trim().toLowerCase())} placeholder={`mail.${domain}`} /></label>
        {another ? <>
          <label>Cloudflare API token<input type="password" required autoComplete="off" spellCheck={false} value={cfToken} onChange={event => setCfToken(event.target.value.trim())} /></label>
          <p className={styles.hint}><a href={tokenLink(product.name)} target="_blank" rel="noreferrer">Create a token</a> with the permissions already picked. It is kept in place of the old one.</p>
        </> : <p className={styles.hint}>Uses the Cloudflare token kept at setup. <button type="button" className={auth.link} onClick={() => setAnother(true)}>Use a new token</button></p>}
        <div className={styles.buttons}>
          <button type="submit" className={styles.primary} disabled={!ready}>{busy ? 'Checking…' : report ? 'Check again' : 'Check'}</button>
          {(red.length > 0 || confirm) && <button type="button" className={styles.secondary} disabled={!ready || Boolean(confirm && typed !== domain)} onClick={() => { void run(true); }}>{confirm ? 'Send the mail here' : 'Fix'}</button>}
        </div>
      </form>
    </div>
  </section>;
}
