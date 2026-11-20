import { useEffect, useState } from 'react';
import product from '../product.json';
import { TOKEN_NEEDS, tokenLink } from '../shared/cloudflare.mjs';
import type { Brand } from './api';
import { post } from './Auth';
import { readLogoFile } from './Brand';
import styles from './auth.module.css';

export type StepKey = 'site' | 'routing' | 'catchAll' | 'sending';
export type Failed = { key: StepKey; problem: string; fix: string; records?: string[] };
type Created = { created?: boolean; address?: string; url?: string; pending?: boolean; done?: StepKey[]; failed?: Failed; confirm?: string[] };

export const stepLabel = (key: StepKey, domain: string, host: string) => ({
  site: `Your site is on https://${host}`, routing: `Mail for ${domain} is turned on`,
  catchAll: `All mail for ${domain} comes here`, sending: `${domain} can send mail`,
}[key]);

/** The installer's link carries a setup code after the #, which never reaches the server's logs. It is read once, when the
 * app loads, then taken out of the address bar so it is not left on screen or in history. */
const linkCode = (() => {
  const match = /^#setup=([\w-]{16,})$/.exec(location.hash);
  if (match) history.replaceState(null, '', location.pathname);
  return match?.[1] ?? '';
})();

/** "Type the domain to go on": shown whenever setting up would send mail that goes somewhere today to this app instead. */
export function Redirect({ domain, places, value, onChange }: { domain: string; places: string[]; value: string; onChange: (value: string) => void }) {
  return <div className={styles.warn} role="alert">
    <strong>This takes over things {domain} uses today</strong>
    <ul>{places.map(place => <li key={place}>{place}</li>)}</ul>
    <p>Going on makes these changes, and all mail for {domain} comes here instead, for everyone at {domain}. Type <b>{domain}</b> to go on, or stop here.</p>
    <input autoComplete="off" spellCheck={false} value={value} onChange={event => onChange(event.target.value.trim().toLowerCase())} placeholder={domain} aria-label={`Type ${domain} to go on`} />
  </div>;
}

type Step = 'proof' | 'business' | 'domain' | 'you';
const NUMBERED: Step[] = ['business', 'domain', 'you'];

/** The setup wizard, shown only while no account exists: your organisation, your domain, then you. The installer's link
 * proves this is your copy, and the installer, still running, sets up mail once the wizard is done. Without the link (a
 * Deploy-button install) the first step asks for a Cloudflare API token, and the last step sets up mail here with it. */
export function Setup({ brand, onDone }: { brand: Brand; onDone: (address: string) => void }) {
  const [step, setStep] = useState<Step>('proof');
  const [code, setCode] = useState(linkCode), [byCode, setByCode] = useState(Boolean(linkCode)), [cfToken, setCfToken] = useState('');
  const [org, setOrg] = useState(brand.name === product.name ? '' : brand.name), [logo, setLogo] = useState('');
  const [domains, setDomains] = useState<string[]>([]), [domain, setDomain] = useState(''), [host, setHost] = useState('');
  const [address, setAddress] = useState(''), [first, setFirst] = useState(''), [last, setLast] = useState(''), [password, setPassword] = useState(''), [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirm, setConfirm] = useState<string[] | null>(null), [typed, setTyped] = useState('');
  const [result, setResult] = useState<Created | null>(null);
  const proof = byCode ? { setupToken: code } : { cfToken };

  const pick = (value: string) => { setDomain(value); const here = location.hostname; setHost(here === value || here.endsWith(`.${value}`) ? here : `mail.${value}`); setConfirm(null); setTyped(''); };
  const check = async () => {
    setBusy(true); setError('');
    try {
      const { ok, result } = await post<{ domains: string[] }>('/api/setup/check', proof);
      if (!ok || !result.domains?.length) { setError(result.error || 'That didn’t work.'); return; }
      setDomains(result.domains); pick(result.domains[0]); setStep('business');
    } catch { setError('Could not reach the server. Try again.'); } finally { setBusy(false); }
  };
  // Opened from the installer's link: the code is checked straight away, so the wizard starts at the first real question.
  useEffect(() => { if (linkCode) void check(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = async (file: File | undefined) => {
    setError('');
    if (!file) return;
    try { setLogo(await readLogoFile(file)); } catch (cause) { setError(cause instanceof Error ? cause.message : 'That picture could not be used.'); }
  };
  const create = async () => {
    if (password !== again) { setError('The two passwords don’t match.'); return; }
    setBusy(true); setError('');
    try {
      const { ok, status, result } = await post<Created>('/api/setup', { ...proof, org, logo, domain, host, confirmed: typed, address, name: `${first.trim()} ${last.trim()}`.trim(), password });
      if (status === 409 && result.confirm) { setConfirm(result.confirm); return; }
      if (!ok || !result.created) { setError(result.error || 'That didn’t work.'); return; }
      setCfToken(''); setPassword(''); setAgain(''); setResult(result);
    } catch { setError('Could not reach the server. Try again.'); } finally { setBusy(false); }
  };
  const back = (to: Step) => <button type="button" className={styles.plain} onClick={() => { setError(''); setStep(to); }}>Back</button>;
  const count = NUMBERED.includes(step) && <p className={styles.count}>Step {NUMBERED.indexOf(step) + 1} of {NUMBERED.length}</p>;

  if (result) {
    const elsewhere = result.url && new URL(result.url).hostname !== location.hostname;
    return <main className={styles.screen}><section className={styles.card}>
      <header><h1>{result.pending ? 'Almost done' : `${org} is set up`}</h1></header>
      <ul className={styles.steps}>
        <li data-ok="true">Your account is {result.address}</li>
        {(result.done || []).map(key => <li key={key} data-ok="true">{stepLabel(key, domain, host)}</li>)}
        {result.failed && <li data-ok="false">{stepLabel(result.failed.key, domain, host)}<small>{result.failed.problem}</small>
          {result.failed.records?.map(line => <small key={line}>{line}</small>)}<small><b>To fix:</b> {result.failed.fix}</small></li>}
      </ul>
      {result.pending && <p className={styles.note}>Go back to the terminal (or your coding agent): the installer is now setting up mail for {domain} and your web address. If a DNS record has to change, it says which. You can sign in here meanwhile.</p>}
      {result.failed && <p className={styles.note}>The steps after this one are not done yet. Once it is fixed, run <b>npm run setup</b> again, or open Setup health in People and mailboxes.</p>}
      {!result.pending && elsewhere && <p className={styles.note}>Your web address is <a href={result.url}>{result.url}</a>. Its certificate can take a few minutes; you can sign in here meanwhile.</p>}
      <form onSubmit={event => { event.preventDefault(); onDone(String(result.address || '').split('@')[0]); }}><button type="submit" autoFocus>Sign in</button></form>
    </section></main>;
  }

  return <main className={styles.screen}><section className={styles.card}>
    <header><h1>{step === 'proof' ? `Set up ${product.name}` : step === 'business' ? 'Your organisation' : step === 'domain' ? 'Your domain' : 'Your account'}</h1></header>
    {count}

    {step === 'proof' && <>
      <p>{byCode ? (linkCode && busy ? 'Checking your setup link…' : 'Enter the setup code the installer printed.')
        : `Paste a Cloudflare API token for the account you deployed ${product.name} to. It proves this is your copy, and sets up your mail. It is used once and not kept.`}</p>
      <form onSubmit={event => { event.preventDefault(); void check(); }}>
        {byCode ? <label>Setup code<input required autoFocus autoComplete="off" spellCheck={false} value={code} onChange={event => setCode(event.target.value.trim())} /></label>
          : <>
            <label>Cloudflare API token<input type="password" required autoFocus autoComplete="off" spellCheck={false} value={cfToken} onChange={event => setCfToken(event.target.value.trim())} /></label>
            <p className={styles.note}><a href={tokenLink(`${product.name}`)} target="_blank" rel="noreferrer">Create a token</a> with the permissions already picked: choose <b>Continue to summary</b>, then <b>Create Token</b>, and copy it here. If the form lacks Email Routing Rules or Email Sending, add them. It needs: {TOKEN_NEEDS.join('; ')}.</p>
          </>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <button type="submit" disabled={busy || (byCode ? code.length < 16 : !cfToken)}>{busy ? 'Checking…' : 'Continue'}</button>
        <button type="button" className={styles.plain} onClick={() => { setByCode(!byCode); setError(''); }}>{byCode ? 'Paste a Cloudflare token instead' : 'I have a setup code'}</button>
      </form>
    </>}

    {step === 'business' && <>
      <p>Its name and logo appear on the sign-in page and at the top of every page. You can change both later.</p>
      <form onSubmit={event => { event.preventDefault(); setError(''); setStep('domain'); }}>
        <label>Organisation name<input required autoFocus value={org} onChange={event => setOrg(event.target.value)} placeholder="Acme Studio" maxLength={80} /></label>
        <div className={styles.logo}>
          <span className={styles.logoBox}>{logo ? <img src={logo} alt="" /> : <i>Logo</i>}</span>
          <label className={styles.file}>{logo ? 'Change logo' : 'Add a logo'}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { void choose(event.target.files?.[0]); event.target.value = ''; }} /></label>
          {logo && <button type="button" className={styles.plain} onClick={() => setLogo('')}>Remove</button>}
          <small>Optional. PNG, JPEG or WebP, up to 512 KB.</small>
        </div>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <button type="submit" disabled={!org.trim()}>Continue</button>
      </form>
    </>}

    {step === 'domain' && <>
      <p>Everyone’s address will be name@{domain}. All mail for {domain} will come here.</p>
      <form onSubmit={event => { event.preventDefault(); setError(''); setStep('you'); }}>
        {domains.length > 1
          ? <label>Domain<select autoFocus value={domain} onChange={event => pick(event.target.value)}>{domains.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
          : <p className={styles.note}>Domain: <b>{domain}</b>. It is the only active domain in this Cloudflare account.</p>}
        <label>Web address<input required value={host} onChange={event => setHost(event.target.value.trim().toLowerCase())} placeholder={`mail.${domain}`} /></label>
        <p className={styles.note}>Where you and your team open {org || 'your mail'}. It must be {domain} or a name under it.</p>
        <button type="submit" disabled={!domain || !host}>Continue</button>
        {back('business')}
      </form>
    </>}

    {step === 'you' && <>
      <p>You are the owner: you add everyone else.</p>
      <form onSubmit={event => { event.preventDefault(); void create(); }}>
        <div className={styles.pair}>
          <label>First name<input required autoFocus autoComplete="given-name" value={first} onChange={event => setFirst(event.target.value)} /></label>
          <label>Last name<input autoComplete="family-name" value={last} onChange={event => setLast(event.target.value)} /></label>
        </div>
        <label>Your address<span className={styles.at}><input required autoComplete="username" value={address} onChange={event => setAddress(event.target.value.trim().toLowerCase())} placeholder="name" /><i>@{domain}</i></span></label>
        <label>Password<input type="password" required minLength={10} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 10 characters" /></label>
        <label>Password again<input type="password" required minLength={10} autoComplete="new-password" value={again} onChange={event => setAgain(event.target.value)} /></label>
        {confirm && <Redirect domain={domain} places={confirm} value={typed} onChange={setTyped} />}
        <p className={styles.note}>{busy ? 'Setting up your mail and web address. This can take a minute.' : 'Next you sign in and set up two-step sign-in with an authenticator app.'}</p>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <button type="submit" disabled={busy || !address || !first.trim() || password.length < 10 || !again || Boolean(confirm && typed !== domain)}>{busy ? 'Setting up…' : 'Finish setup'}</button>
        {!busy && back('domain')}
      </form>
    </>}
  </section></main>;
}
