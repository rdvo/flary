import { PRODUCT, changed, domainOf, hex, json, ourAddress, randomHex, readJson, sha, type Env } from './util';

export type Role = 'owner' | 'admin' | 'member';
export type Account = { id: string; name: string; role: Role; address: string; mailboxId: string };

const COOKIE = '__Host-session', SESSION_MS = 30 * 86_400_000, LOCK_MS = 15 * 60_000;
const cookieOf = (request: Request) => new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})`).exec(request.headers.get('cookie') || '')?.[1] ?? null;
const setCookie = (value: string, seconds: number) => `${COOKIE}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;

export async function passwordHash(password: string, salt = randomHex(16)) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100_000 }, key, 256);
  return `${salt}:${hex(bits)}`;
}

/** A password the owner hands over once: 14 characters with no look-alikes. The person replaces it at first sign-in. */
export const tempPassword = () => [...crypto.getRandomValues(new Uint8Array(14))].map(byte => 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'[byte % 54]).join('');

/** The account this browser is signed in to, if any. */
export async function readSession(request: Request, env: Env): Promise<Account | null> {
  const token = cookieOf(request);
  if (!token) return null;
  return await env.DB.prepare('SELECT a.id,a.name,a.role,a.mailbox_id AS mailboxId,m.address FROM session s JOIN account a ON a.id=s.account_id JOIN mailbox m ON m.id=a.mailbox_id WHERE s.token=?1 AND s.expires_at>?2')
    .bind(await sha(token), Date.now()).first<Account>() ?? null;
}

// Two-step codes: the standard six-digit, 30-second code an authenticator app shows (RFC 6238).
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const newSecret = () => [...crypto.getRandomValues(new Uint8Array(32))].map(byte => B32[byte % 32]).join('');
function unbase32(secret: string) {
  let bits = '';
  for (const char of secret) bits += B32.indexOf(char).toString(2).padStart(5, '0');
  return Uint8Array.from(bits.match(/.{8}/g) || [], byte => parseInt(byte, 2));
}
async function codeAt(secret: string, step: number) {
  const key = await crypto.subtle.importKey('raw', unbase32(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const counter = new Uint8Array(8); new DataView(counter.buffer).setUint32(4, step);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter)), at = mac[19] & 15;
  return String((((mac[at] & 127) << 24) | (mac[at + 1] << 16) | (mac[at + 2] << 8) | mac[at + 3]) % 1_000_000).padStart(6, '0');
}
/** The 30-second step a code belongs to (this one or the one either side, never one already used), or 0 when it is wrong. */
async function codeStep(secret: string, code: string, after: number, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return 0;
  const current = Math.floor(now / 30_000);
  for (const step of [current, current - 1, current + 1]) if (step > after && await codeAt(secret, step) === code) return step;
  return 0;
}

/** One request does the whole sign-in and answers with what is still missing (`need`), so the page asks for it and sends
 * again: a first sign-in must choose its own password; an owner or admin must set up, then give, a six-digit code. */
export async function signIn(request: Request, env: Env) {
  const input = await readJson<{ address: string; password: string; newPassword: string; code: string }>(request), now = Date.now();
  const typed = String(input.address || '').trim().toLowerCase(), address = ourAddress(env, typed.includes('@') ? typed : `${typed}@${domainOf(env)}`);
  const password = String(input.password || '').slice(0, 200);
  const account = address ? await env.DB.prepare('SELECT a.id,a.role,a.password,a.locked_until AS lockedUntil,a.must_change AS mustChange,a.totp,a.totp_pending AS pending,a.totp_step AS step FROM account a JOIN mailbox m ON m.id=a.mailbox_id WHERE m.address=?1')
    .bind(address).first<{ id: string; role: string; password: string; lockedUntil: number; mustChange: number; totp: string | null; pending: string | null; step: number }>() : null;
  if (account && account.lockedUntil > now) return json({ error: 'Too many wrong tries. Try again in 15 minutes.' }, 429);
  // Five wrong answers in a row lock the account for 15 minutes.
  const strike = () => env.DB.prepare('UPDATE account SET failed=CASE WHEN failed>=4 THEN 0 ELSE failed+1 END,locked_until=CASE WHEN failed>=4 THEN ?1 ELSE locked_until END WHERE id=?2').bind(now + LOCK_MS, account!.id).run();
  // The same work and the same answer whether or not the account exists.
  const salt = account?.password.split(':')[0] || 'none', right = (await passwordHash(password, salt)) === account?.password;
  if (!account || !right) { if (account) await strike(); return json({ error: 'That address and password don’t match.' }, 401); }

  if (account.mustChange) {
    const next = String(input.newPassword || '');
    if (!next) return json({ need: 'password', error: 'Choose your own password to finish signing in.' }, 409);
    if (next.length < 10 || next.length > 200 || next === password) return json({ need: 'password', error: 'Choose a new password of at least 10 characters.' }, 409);
    // Saved now, so the rest of this sign-in, and any retry of it, uses the new password.
    await env.DB.prepare('UPDATE account SET password=?1,must_change=0 WHERE id=?2').bind(await passwordHash(next), account.id).run();
  }
  const changedPassword = Boolean(account.mustChange), code = String(input.code || '').replace(/\s/g, '');
  const wrong = code ? 'That code isn’t right. Use the newest one in your app.' : '';
  if (account.totp) {
    const step = await codeStep(account.totp, code, account.step, now);
    if (!step) { if (code) await strike(); return json({ need: 'code', changed: changedPassword, error: wrong || 'Enter the six-digit code from your authenticator app.' }, 409); }
    // Claimed with a condition, so two sign-ins racing with one code cannot both pass.
    if (!changed(await env.DB.prepare('UPDATE account SET totp_step=?1 WHERE id=?2 AND totp_step<?1').bind(step, account.id).run()))
      return json({ need: 'code', changed: changedPassword, error: 'That code was already used. Wait for the next one.' }, 409);
  } else if (account.role === 'owner' || account.role === 'admin') {
    const pending = account.pending || newSecret(), step = code && account.pending ? await codeStep(pending, code, 0, now) : 0;
    if (!step) {
      if (!account.pending) await env.DB.prepare('UPDATE account SET totp_pending=?1 WHERE id=?2').bind(pending, account.id).run();
      else if (code) await strike();
      const label = encodeURIComponent(`${PRODUCT}:${address}`), issuer = encodeURIComponent(PRODUCT);
      return json({ need: 'setup', changed: changedPassword, secret: pending, uri: `otpauth://totp/${label}?secret=${pending}&issuer=${issuer}`, error: wrong || 'Set up two-step sign-in.' }, 409);
    }
    if (!changed(await env.DB.prepare('UPDATE account SET totp=?1,totp_pending=NULL,totp_step=?2 WHERE id=?3 AND totp IS NULL AND totp_pending=?1').bind(pending, step, account.id).run()))
      return json({ error: 'Two-step sign-in changed while you were setting it up. Start again.' }, 409);
  }

  const token = randomHex(32);
  await env.DB.batch([
    env.DB.prepare('UPDATE account SET failed=0,locked_until=0 WHERE id=?1').bind(account.id),
    env.DB.prepare('DELETE FROM session WHERE expires_at<?1').bind(now),
    env.DB.prepare('INSERT INTO session(token,account_id,expires_at) VALUES(?1,?2,?3)').bind(await sha(token), account.id, now + SESSION_MS),
  ]);
  return json({ signedIn: true }, 200, { 'set-cookie': setCookie(token, SESSION_MS / 1000) });
}

export async function signOut(request: Request, env: Env) {
  const token = cookieOf(request);
  if (token) await env.DB.prepare('DELETE FROM session WHERE token=?1').bind(await sha(token)).run();
  return json({ signedOut: true }, 200, { 'set-cookie': setCookie('', 0) });
}

export const hasAccounts = async (env: Env) => Boolean(await env.DB.prepare('SELECT 1 FROM account LIMIT 1').first());

/** A signed-in person replaces their own password. The current one is required (a wrong one counts toward the lockout), and
 * every other session of the account is signed out; this browser stays signed in. */
export async function changePassword(request: Request, env: Env, account: Account) {
  const input = await readJson<{ current: string; next: string }>(request), now = Date.now();
  const row = await env.DB.prepare('SELECT password,locked_until AS lockedUntil FROM account WHERE id=?1').bind(account.id).first<{ password: string; lockedUntil: number }>();
  if (!row) return json({ error: 'Sign in first.' }, 401);
  if (row.lockedUntil > now) return json({ error: 'Too many wrong tries. Try again in 15 minutes.' }, 429);
  const current = String(input.current || '').slice(0, 200), next = String(input.next || '');
  if ((await passwordHash(current, row.password.split(':')[0])) !== row.password) {
    await env.DB.prepare('UPDATE account SET failed=CASE WHEN failed>=4 THEN 0 ELSE failed+1 END,locked_until=CASE WHEN failed>=4 THEN ?1 ELSE locked_until END WHERE id=?2').bind(now + LOCK_MS, account.id).run();
    return json({ error: 'Your current password isn’t right.' }, 403);
  }
  if (next.length < 10 || next.length > 200 || next === current) return json({ error: 'Choose a new password of at least 10 characters.' }, 400);
  const token = cookieOf(request), kept = token ? await sha(token) : '';
  // Conditional on the old hash, so two changes racing cannot both win.
  const [saved] = await env.DB.batch([
    env.DB.prepare('UPDATE account SET password=?1,must_change=0,failed=0,locked_until=0 WHERE id=?2 AND password=?3').bind(await passwordHash(next), account.id, row.password),
    env.DB.prepare('DELETE FROM session WHERE account_id=?1 AND token<>?2 AND EXISTS (SELECT 1 FROM account WHERE id=?1 AND password<>?3)').bind(account.id, kept, row.password),
  ]);
  if (!changed(saved)) return json({ error: 'Your password changed while you were doing this. Try again.' }, 409);
  return json({ changed: true });
}
