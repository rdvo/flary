import { useEffect, useState } from 'react';
import product from '../product.json';
import { tokenLink } from '../shared/cloudflare.mjs';
import type { Session } from './api';
import { post } from './Auth';
import { Redirect, stepLabel, type Failed, type StepKey } from './Setup';
import styles from './org.module.css';
import auth from './auth.module.css';

type Item = { key: StepKey; ok: boolean; label: string; detail?: string; fix?: string };
type Installed = { at: number; done: StepKey[]; failed?: Failed } | null;
type Report = { host?: string; items?: Item[]; failed?: Failed; confirm?: string[]; report?: Installed };

/** The owner's Setup health. It shows what the installer last did; nothing here keeps a Cloudflare token. To check again or
 * fix, run `npm run setup` again (it signs in on your computer), or paste a token here for one check. */
export function Health({ session }: { session: Session }) {
  const domain = session.domain, host = session.host || `mail.${domain}`;
  const [cfToken, setCfToken] = useState(''), [paste, setPaste] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [report, setReport] = useState<Report | null>(null), [installed, setInstalled] = useState<Installed>(null);
  const [confirm, setConfirm] = useState<string[] | null>(null), [typed, setTyped] = useState('');
  const run = async (fix: boolean) => {
    setBusy(true); setError('');
    try {
      const { ok, status, result } = await post<Report>('/api/health', { cfToken, host, fix, confirmed: typed });
      if (status === 409 && result.confirm) { setConfirm(result.confirm); return; }
      if (!ok) { setError(result.error || 'That didn’t work.'); return; }
      if ('report' in result) setInstalled(result.report ?? null); else { setReport(result); setConfirm(null); setTyped(''); }
    } catch { setError('Could not reach the server. Try again.'); } finally { setBusy(false); }
  };
  useEffect(() => { void run(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const failure = report?.failed ?? (report ? undefined : installed?.failed);
  const red = report?.items?.filter(item => !item.ok) ?? [];
  return <section className={styles.section}>
    <div className={styles.head}><h2>Setup health</h2><p>Whether mail for {domain} comes in here and can go out, and whether https://{host} opens {product.name}.</p></div>
    <div className={styles.body}>
      {report?.items ? <ul className={auth.steps}>
        {report.items.map(item => <li key={`${item.key}${item.label}`} data-ok={item.ok}>{item.label}{item.detail && <small>{item.detail}</small>}{!item.ok && item.fix && <small><b>To fix:</b> {item.fix}</small>}</li>)}
      </ul> : installed && <ul className={auth.steps}>
        {installed.done.map(key => <li key={key} data-ok="true">{stepLabel(key, domain, host)}</li>)}
        {installed.failed && <li data-ok="false">{stepLabel(installed.failed.key, domain, host)}</li>}
      </ul>}
      {failure && <div role="alert" className={styles.error}><div>{failure.problem}{failure.records?.map(line => <div key={line}>{line}</div>)} To fix: {failure.fix}</div></div>}
      {confirm && <Redirect domain={domain} places={confirm} value={typed} onChange={setTyped} />}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <p className={styles.hint}>{installed ? `The installer last ran ${new Date(installed.at).toLocaleString()}. ` : ''}To check again and fix anything, run <b>npm run setup</b> in the {product.slug} folder, or ask your coding agent to. It signs in to Cloudflare on your computer; no token is kept here.</p>
      {paste ? <form className={styles.form} onSubmit={event => { event.preventDefault(); void run(false); }}>
        <label>Cloudflare API token<input type="password" required autoComplete="off" spellCheck={false} value={cfToken} onChange={event => setCfToken(event.target.value.trim())} /></label>
        <p className={styles.hint}><a href={tokenLink(product.name)} target="_blank" rel="noreferrer">Create a token</a> with the permissions already picked. It is used for this check and not kept.</p>
        <div className={styles.buttons}>
          <button type="submit" className={styles.primary} disabled={busy || !cfToken}>{busy ? 'Checking…' : report ? 'Check again' : 'Check'}</button>
          {(red.length > 0 || confirm) && <button type="button" className={styles.secondary} disabled={busy || !cfToken || Boolean(confirm && typed !== domain)} onClick={() => { void run(true); }}>{confirm ? 'Send the mail here' : 'Fix'}</button>}
        </div>
      </form> : <p className={styles.hint}><button type="button" className={auth.link} onClick={() => setPaste(true)}>Or check here with a Cloudflare token</button></p>}
    </div>
  </section>;
}
