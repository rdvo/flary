import { useState } from 'react';
import product from '../product.json';
import { tokenLink } from '../shared/cloudflare.mjs';
import { post } from './Auth';
import { Redirect, type Failed, type StepKey } from './Setup';
import styles from './org.module.css';
import auth from './auth.module.css';

type Item = { key: StepKey; ok: boolean; label: string; detail?: string; fix?: string };
type Report = { host?: string; items?: Item[]; failed?: Failed; confirm?: string[] };

/** The owner's Setup health: is mail coming in and going out, with the plain fix for anything red. Checking needs a
 * Cloudflare API token, which the server uses for that one request; this page keeps it only while it is open. */
export function Health({ domain }: { domain: string }) {
  const [cfToken, setCfToken] = useState(''), [host, setHost] = useState(() => location.hostname.endsWith('.workers.dev') ? `mail.${domain}` : location.hostname);
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
  return <section className={styles.section}>
    <div className={styles.head}><h2>Setup health</h2><p>Whether mail for {domain} comes in here and can go out. Checking needs a Cloudflare API token for this account; it is used for the check and not kept.</p></div>
    <div className={styles.body}>
      {report?.items && <ul className={auth.steps}>
        {report.items.map(item => <li key={`${item.key}${item.label}`} data-ok={item.ok}>{item.label}{item.detail && <small>{item.detail}</small>}{!item.ok && item.fix && <small><b>To fix:</b> {item.fix}</small>}</li>)}
      </ul>}
      {report?.failed && <p role="alert" className={styles.error}>{report.failed.problem} To fix: {report.failed.fix}</p>}
      {confirm && <Redirect domain={domain} places={confirm} value={typed} onChange={setTyped} />}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <form className={styles.form} onSubmit={event => { event.preventDefault(); void run(false); }}>
        <label>Cloudflare API token<input type="password" required autoComplete="off" spellCheck={false} value={cfToken} onChange={event => setCfToken(event.target.value.trim())} /></label>
        <label>Web address<input required value={host} onChange={event => setHost(event.target.value.trim().toLowerCase())} placeholder={`mail.${domain}`} /></label>
        <p className={styles.hint}><a href={tokenLink(`${product.name} setup`)} target="_blank" rel="noreferrer">Create a token</a> with the permissions already picked, if you don’t have one.</p>
        <div className={styles.buttons}>
          <button type="submit" className={styles.primary} disabled={busy || !cfToken}>{busy ? 'Checking…' : report ? 'Check again' : 'Check'}</button>
          {(red.length > 0 || confirm) && <button type="button" className={styles.secondary} disabled={busy || !cfToken || Boolean(confirm && typed !== domain)} onClick={() => { void run(true); }}>{confirm ? 'Send the mail here' : 'Fix these'}</button>}
        </div>
      </form>
    </div>
  </section>;
}
