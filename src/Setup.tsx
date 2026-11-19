import { useState } from 'react';
import product from '../product.json';
import { TOKEN_NEEDS, tokenLink } from '../shared/cloudflare.mjs';
import { post } from './Auth';
import styles from './auth.module.css';

export type StepKey = 'site' | 'routing' | 'catchAll' | 'sending';
export type Failed = { key: StepKey; problem: string; fix: string };
type Created = { created?: boolean; address?: string; url?: string; done?: StepKey[]; failed?: Failed; confirm?: string[] };

export const stepLabel = (key: StepKey, domain: string, host: string) => ({
  site: `${product.name} is on https://${host}`, routing: `Email Routing is on for ${domain}`,
  catchAll: `All mail for ${domain} comes here`, sending: `${domain} can send mail`,
}[key]);

/** The setup script's link carries a setup code after the #, which never reaches the server's logs. It is read once, when
 * the app loads, then taken out of the address bar so it is not left on screen or in history. */
const linkCode = (() => {
  const match = /^#setup=([\w-]{16,})$/.exec(location.hash);
  if (match) history.replaceState(null, '', location.pathname);
  return match?.[1] ?? '';
})();

/** "Type the domain to go on": shown whenever setting up would send mail that goes somewhere today to this app instead. */
export function Redirect({ domain, places, value, onChange }: { domain: string; places: string[]; value: string; onChange: (value: string) => void }) {
  return <div className={styles.warn} role="alert">
    <strong>{domain} already gets mail somewhere else</strong>
    <ul>{places.map(place => <li key={place}>{place}</li>)}</ul>
    <p>Going on sends all mail for {domain} to {product.name} instead, for everyone at {domain}. Type <b>{domain}</b> to go on, or stop here.</p>
    <input autoComplete="off" spellCheck={false} value={value} onChange={event => onChange(event.target.value.trim().toLowerCase())} placeholder={domain} aria-label={`Type ${domain} to go on`} />
  </div>;
}

/** The first visit, shown only while no account exists. Opened from the setup script's link it carries a setup code and asks
 * only for the owner. Otherwise it asks for a Cloudflare API token, which proves the visitor runs this Cloudflare account
 * and lets the server finish what a Deploy button could not: mail in, mail out, and the web address. */
export function Setup({ domain: preset, onDone }: { domain: string; onDone: (address: string) => void }) {
  const [code, setCode] = useState(linkCode), [byCode, setByCode] = useState(Boolean(linkCode));
  const [cfToken, setCfToken] = useState(''), [domains, setDomains] = useState<string[] | null>(null), [domain, setDomain] = useState(preset), [host, setHost] = useState('');
  const [address, setAddress] = useState(''), [name, setName] = useState(''), [password, setPassword] = useState(''), [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirm, setConfirm] = useState<string[] | null>(null), [typed, setTyped] = useState('');
  const [result, setResult] = useState<Created | null>(null);

  const pick = (value: string) => { setDomain(value); const here = location.hostname; setHost(here === value || here.endsWith(`.${value}`) ? here : `mail.${value}`); setConfirm(null); setTyped(''); };
  const check = async () => {
    setBusy(true); setError('');
    try {
      const { ok, result } = await post<{ domains: string[] }>('/api/setup/check', { cfToken });
      if (!ok || !result.domains?.length) { setError(result.error || 'That didn’t work.'); return; }
      setDomains(result.domains); pick(result.domains.includes(preset) ? preset : result.domains[0]);
    } catch { setError('Could not reach the server. Try again.'); } finally { setBusy(false); }
  };
  const create = async () => {
    if (password !== again) { setError('The two passwords don’t match.'); return; }
    setBusy(true); setError('');
    try {
      const owner = { address, name, password };
      const { ok, status, result } = await post<Created>('/api/setup', byCode ? { setupToken: code, ...owner } : { cfToken, domain, host, confirmed: typed, ...owner });
      if (status === 409 && result.confirm) { setConfirm(result.confirm); return; }
      if (!ok || !result.created) { setError(result.error || 'That didn’t work.'); return; }
      setCfToken(''); setPassword(''); setAgain('');
      if (byCode) onDone(String(result.address || '').split('@')[0]); else setResult(result);
    } catch { setError('Could not reach the server. Try again.'); } finally { setBusy(false); }
  };

  if (result) {
    const elsewhere = result.url && new URL(result.url).hostname !== location.hostname;
    return <main className={styles.screen}><section className={styles.card}>
      <header><h1>Your account is ready</h1></header>
      <ul className={styles.steps}>
        {(result.done || []).map(key => <li key={key} data-ok="true">{stepLabel(key, domain, host)}</li>)}
        {result.failed && <li data-ok="false">{stepLabel(result.failed.key, domain, host)}<small>{result.failed.problem}</small><small><b>To fix:</b> {result.failed.fix}</small></li>}
      </ul>
      {result.failed && <p className={styles.note}>Everything after this step is not done yet. Once it is fixed, open Setup health in the org panel and check again.</p>}
      {elsewhere && <p className={styles.note}>Your web address is <a href={result.url}>{result.url}</a>. Its certificate can take a few minutes; you can sign in here meanwhile.</p>}
      <form onSubmit={event => { event.preventDefault(); onDone(String(result.address || '').split('@')[0]); }}><button type="submit" autoFocus>Sign in</button></form>
    </section></main>;
  }

  const ready = byCode ? code.length >= 16 : Boolean(domains && domain);
  const ownerReady = address && name && password.length >= 10 && again && (!confirm || typed === domain);
  return <main className={styles.screen}><section className={styles.card}>
    <header><h1>Set up {product.name}</h1></header>
    {byCode
      ? <p>Create the owner account. The owner adds everyone else.</p>
      : !domains
        ? <p>First, a Cloudflare API token for the account you deployed {product.name} to. It proves this is your copy and turns on mail for your domain. It is used once and not kept.</p>
        : <p>Now the owner account. The owner adds everyone else.</p>}
    <form onSubmit={event => { event.preventDefault(); void (ready ? create() : check()); }}>
      {byCode && !linkCode && <label>Setup code<input required autoFocus autoComplete="off" spellCheck={false} value={code} onChange={event => setCode(event.target.value.trim())} /></label>}
      {!byCode && !domains && <>
        <label>Cloudflare API token<input type="password" required autoFocus autoComplete="off" spellCheck={false} value={cfToken} onChange={event => setCfToken(event.target.value.trim())} /></label>
        <p className={styles.note}><a href={tokenLink(`${product.name} setup`)} target="_blank" rel="noreferrer">Create a token</a> with the permissions already picked: choose <b>Continue to summary</b>, then <b>Create Token</b>, and copy it here. If the form lacks Email Routing Rules or Email Sending, add them. It needs: {TOKEN_NEEDS.join('; ')}.</p>
      </>}
      {!byCode && domains && <>
        {domains.length > 1
          ? <label>Domain<select value={domain} onChange={event => pick(event.target.value)}>{domains.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
          : <p className={styles.note}>Domain: <b>{domain}</b>. Addresses will be name@{domain}.</p>}
        <label>Web address<input required value={host} onChange={event => setHost(event.target.value.trim().toLowerCase())} placeholder={`mail.${domain}`} /></label>
      </>}
      {ready && <>
        <label>Your address<span className={styles.at}><input required autoFocus={byCode} autoComplete="username" value={address} onChange={event => setAddress(event.target.value.trim().toLowerCase())} placeholder="name" /><i>@{domain || 'your domain'}</i></span></label>
        <label>Your name<input required autoComplete="name" value={name} onChange={event => setName(event.target.value)} placeholder="First and last name" /></label>
        <label>Password<input type="password" required minLength={10} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 10 characters" /></label>
        <label>Password again<input type="password" required minLength={10} autoComplete="new-password" value={again} onChange={event => setAgain(event.target.value)} /></label>
        {confirm && <Redirect domain={domain} places={confirm} value={typed} onChange={setTyped} />}
        <p className={styles.note}>Next you sign in and set up two-step sign-in with an authenticator app.</p>
      </>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {ready
        ? <button type="submit" disabled={busy || !ownerReady}>{busy ? 'Setting up…' : 'Create owner account'}</button>
        : <button type="submit" disabled={busy || (byCode ? code.length < 16 : !cfToken)}>{busy ? 'Checking…' : 'Continue'}</button>}
      <button type="button" className={styles.plain} onClick={() => { setByCode(!byCode); setError(''); setConfirm(null); }}>{byCode ? 'Use a Cloudflare token instead' : 'I have a setup code'}</button>
    </form>
  </section></main>;
}
