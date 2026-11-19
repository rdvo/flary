import { useCallback, useEffect, useRef, useState } from 'react';

export type Role = 'owner' | 'admin' | 'member';
export type Account = { id: string; name: string; role: Role; address: string; mailboxId: string };
export type MailboxInfo = { id: string; address: string; name: string; kind: 'personal' | 'shared'; unread: number };
export type Brand = { name: string; logo: string | null };
export type Session = { domain: string; host: string; brand: Brand; setup: boolean; account: Account | null; mailboxes: MailboxInfo[]; welcomed?: boolean; cloudflare?: boolean };

/** Fired when the server says the session is gone, so the app shows the sign-in again. */
export const SIGNED_OUT = 'session-ended';

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', method: init?.method ?? 'GET', ...(init?.body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) } : {}) });
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (response.status === 401) dispatchEvent(new Event(SIGNED_OUT));
  if (!response.ok) throw new Error(result.error || 'That didn’t work.');
  return result;
}

/** Data read on load, whenever `deps` change, when the tab comes back into view, and every `every` ms while it is in view. */
export function useData<T>(load: () => Promise<T>, deps: unknown[], every = 60_000) {
  const [state, setState] = useState<{ data: T | null; error: string }>({ data: null, error: '' });
  const latest = useRef(load), sequence = useRef(0);
  latest.current = load;
  const reload = useCallback(async () => {
    const id = ++sequence.current;
    try { const data = await latest.current(); if (id === sequence.current) setState({ data, error: '' }); }
    catch (cause) { if (id === sequence.current) setState(previous => ({ data: previous.data, error: cause instanceof Error ? cause.message : 'That didn’t work.' })); }
  }, []);
  useEffect(() => { setState({ data: null, error: '' }); void reload(); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const shown = () => { if (document.visibilityState === 'visible') void reload(); };
    const timer = setInterval(shown, every);
    document.addEventListener('visibilitychange', shown);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', shown); };
  }, [reload, every]);
  return { ...state, reload };
}

/** Moves within the app without a page load. */
export const navigate = (path: string) => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); };

export const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
export function onSchemeChange(listener: () => void) {
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  scheme.addEventListener('change', listener);
  return () => scheme.removeEventListener('change', listener);
}
