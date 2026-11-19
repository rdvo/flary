import { useState } from 'react';
import type { Brand } from './api';
import { BrandMark } from './Brand';
import styles from './auth.module.css';

type Need = '' | 'password' | 'setup' | 'code';
export const post = async <T = Record<string, string | boolean | undefined>>(path: string, body: unknown) => {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: response.ok, status: response.status, result: await response.json().catch(() => ({})) as T & { error?: string } };
};

/** The sign-in. It asks for each thing the server says is still missing: your own password on a first sign-in, and the
 * six-digit code where two-step sign-in applies (setting it up first if it isn't yet). */
export function SignIn({ brand, domain, address: start = '', onDone }: { brand: Brand; domain: string; address?: string; onDone: () => void }) {
  const [address, setAddress] = useState(start), [password, setPassword] = useState(''), [next, setNext] = useState(''), [code, setCode] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [need, setNeed] = useState<Need>(''), [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const go = async () => {
    setBusy(true); setError('');
    try {
      const { ok, result } = await post('/api/auth/signin', { address, password, ...(need === 'password' ? { newPassword: next } : {}), ...(code ? { code } : {}) });
      if (ok && result.signedIn) { onDone(); return; }
      // Once the server has saved the new password, it is the one the remaining steps send.
      if (need === 'password' && result.changed) { setPassword(next); setNext(''); }
      if (result.need === 'setup' && typeof result.secret === 'string' && typeof result.uri === 'string') {
        const QRCode = (await import('qrcode')).default;
        setSetup({ secret: result.secret, qr: await QRCode.toDataURL(result.uri, { margin: 1, width: 176 }) });
      }
      const asked = typeof result.need === 'string' && result.need !== need;
      if (typeof result.need === 'string') setNeed(result.need as Need);
      setCode('');
      setError(asked ? '' : String(result.error || 'That didn’t work.'));
    } catch { setError('Could not reach the server. Try again.'); } finally { setBusy(false); }
  };
  const disabled = busy || !address || !password || (need === 'password' && next.length < 10) || ((need === 'setup' || need === 'code') && code.length !== 6);
  return <main className={styles.screen}><section className={styles.card}>
    <header><h1><BrandMark brand={brand} /></h1></header>
    <p>{need === 'password' ? 'First sign-in: choose your own password.'
      : need === 'setup' ? 'Set up two-step sign-in. Scan this with an authenticator app (1Password, Google Authenticator, Authy), then enter the six-digit code it shows.'
      : need === 'code' ? 'Enter the six-digit code from your authenticator app.' : `Sign in with your @${domain} address.`}</p>
    <form onSubmit={event => { event.preventDefault(); void go(); }}>
      {!need && <>
        <label>Address<span className={styles.at}><input required autoFocus autoComplete="username" value={address} onChange={event => setAddress(event.target.value.trim().toLowerCase())} placeholder="name" /><i>@{domain}</i></span></label>
        <label>Password<input type="password" required autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
      </>}
      {need === 'password' && <label>New password<input type="password" required autoFocus minLength={10} autoComplete="new-password" value={next} onChange={event => setNext(event.target.value)} placeholder="At least 10 characters" /></label>}
      {need === 'setup' && setup && <div className={styles.qr}><img src={setup.qr} alt="Two-step sign-in QR code" width={176} height={176} /><small>Or type this key into the app: <code>{setup.secret}</code></small></div>}
      {(need === 'setup' || need === 'code') && <label>Six-digit code<input required autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={event => setCode(event.target.value.replace(/[^0-9]/g, ''))} placeholder="123456" /></label>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <button type="submit" disabled={disabled}>{busy ? 'Checking…' : need ? 'Continue' : 'Sign in'}</button>
    </form>
  </section></main>;
}

/** A signed-in person changes their own password. Every other place they are signed in is signed out. */
export function ChangePassword({ address, onBack }: { address: string; onBack: () => void }) {
  const [current, setCurrent] = useState(''), [next, setNext] = useState(''), [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [done, setDone] = useState(false);
  const go = async () => {
    if (next !== again) { setError('The two new passwords don’t match.'); return; }
    setBusy(true); setError('');
    try {
      const { ok, result } = await post('/api/auth/password', { current, next });
      if (ok && result.changed) { setDone(true); setCurrent(''); setNext(''); setAgain(''); return; }
      setError(String(result.error || 'That didn’t work.'));
    } catch { setError('Could not reach the server. Try again.'); } finally { setBusy(false); }
  };
  return <main className={styles.screen}><section className={styles.card}>
    <header><h1>Change your password</h1></header>
    <p>{done ? 'Your password is changed. Everywhere else you were signed in has been signed out.' : `For ${address}. Other places you are signed in will be signed out.`}</p>
    {done ? <form onSubmit={event => { event.preventDefault(); onBack(); }}><button type="submit" autoFocus>Back to mail</button></form>
      : <form onSubmit={event => { event.preventDefault(); void go(); }}>
        <input type="text" hidden readOnly autoComplete="username" value={address} />
        <label>Current password<input type="password" required autoFocus autoComplete="current-password" value={current} onChange={event => setCurrent(event.target.value)} /></label>
        <label>New password<input type="password" required minLength={10} autoComplete="new-password" value={next} onChange={event => setNext(event.target.value)} placeholder="At least 10 characters" /></label>
        <label>New password again<input type="password" required minLength={10} autoComplete="new-password" value={again} onChange={event => setAgain(event.target.value)} /></label>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <button type="submit" disabled={busy || !current || next.length < 10 || !again}>{busy ? 'Saving…' : 'Change password'}</button>
        <button type="button" className={styles.plain} onClick={onBack}>Cancel</button>
      </form>}
  </section></main>;
}

