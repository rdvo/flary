import { changePassword, hasAccounts, readSession, signIn, signOut } from './auth';
import { mailRoute, myMailboxes, receive } from './mail';
import { orgRoute } from './org';
import { ensureSchema } from './schema';
import { checkToken, firstRun, health, withDomain } from './setup';
import { domainOf, json, type Bindings, type Env } from './util';

async function api(request: Request, env: Env, context: ExecutionContext) {
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, '');
  // Every change must come from a page on this site.
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.get('origin') !== url.origin) return json({ error: 'Open this page from its own site.' }, 403);

  if (path === '/api/session' && request.method === 'GET') {
    const account = await readSession(request, env);
    if (!account) return json({ domain: domainOf(env), setup: !(await hasAccounts(env)), account: null, mailboxes: [] });
    return json({ domain: domainOf(env), setup: false, account: { id: account.id, name: account.name, role: account.role, address: account.address, mailboxId: account.mailboxId }, mailboxes: await myMailboxes(env, account) });
  }
  if (path === '/api/auth/signin' && request.method === 'POST') return signIn(request, env);
  if (path === '/api/auth/signout' && request.method === 'POST') return signOut(request, env);
  // The first-run screen. Both answer 404 once the owner exists.
  if (path === '/api/setup/check' && request.method === 'POST') return checkToken(request, env);
  if (path === '/api/setup' && request.method === 'POST') return firstRun(request, env);

  const account = await readSession(request, env);
  if (!account) return json({ error: 'Sign in first.' }, 401);
  if (path === '/api/auth/password' && request.method === 'POST') return changePassword(request, env, account);
  if (path === '/api/health' && request.method === 'POST') return health(request, env, account);
  if (path === '/api/mail' || path.startsWith('/api/mail/')) return mailRoute(request, env, account, path.slice('/api/mail'.length).replace(/^\//, ''));
  if (path === '/api/org' || path.startsWith('/api/org/')) return orgRoute(request, env, context, account, path.slice('/api/org'.length).replace(/^\//, ''));
  return json({ error: 'Not found.' }, 404);
}

export default {
  async fetch(request, bindings, context) {
    if (!new URL(request.url).pathname.startsWith('/api/')) return bindings.ASSETS.fetch(request);
    try {
      await ensureSchema(bindings.DB);
      return await api(request, await withDomain(bindings), context);
    } catch (error) {
      console.error('api_failed', error instanceof Error ? error.stack || error.message : error);
      return json({ error: 'Something went wrong. Try again.' }, 500);
    }
  },
  async email(message, bindings) {
    await ensureSchema(bindings.DB);
    const env = await withDomain(bindings);
    if (!env.DOMAIN) { message.setReject('This mail server is not set up yet.'); return; }
    await receive(message, env);
  },
} satisfies ExportedHandler<Bindings>;
