import { changePassword, hasAccounts, readSession, signIn, signOut } from './auth';
import { mailRoute, myMailboxes, receive } from './mail';
import { brandOf, logoFile, settings, updateBrand } from './brand';
import { orgRoute } from './org';
import { ensureSchema } from './schema';
import { checkToken, firstRun, health, withDomain } from './setup';
import { domainOf, json, type Bindings, type Env } from './util';

async function api(request: Request, env: Env, context: ExecutionContext) {
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, '');
  // Every change must come from a page on this site.
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.get('origin') !== url.origin) return json({ error: 'Open this page from its own site.' }, 403);

  if (path === '/api/session' && request.method === 'GET') {
    const [account, saved] = await Promise.all([readSession(request, env), settings(env)]);
    const shared = { domain: domainOf(env), host: saved.host || '', brand: brandOf(saved) };
    if (!account) return json({ ...shared, setup: !(await hasAccounts(env)), account: null, mailboxes: [] });
    // Only the owner needs to know whether the welcome step is done and whether a Cloudflare token is kept.
    const owner = account.role === 'owner' ? { welcomed: Boolean(saved.welcomed), cloudflare: Boolean(env.CF_API_TOKEN) } : {};
    return json({ ...shared, ...owner, setup: false, account: { id: account.id, name: account.name, role: account.role, address: account.address, mailboxId: account.mailboxId }, mailboxes: await myMailboxes(env, account) });
  }
  if (path === '/api/brand/logo' && request.method === 'GET') return logoFile(env);
  if (path === '/api/auth/signin' && request.method === 'POST') return signIn(request, env);
  if (path === '/api/auth/signout' && request.method === 'POST') return signOut(request, env);
  // The setup wizard. Both answer 404 once the owner exists.
  if (path === '/api/setup/check' && request.method === 'POST') return checkToken(request, env);
  if (path === '/api/setup' && request.method === 'POST') return firstRun(request, env);

  const account = await readSession(request, env);
  if (!account) return json({ error: 'Sign in first.' }, 401);
  if (path === '/api/auth/password' && request.method === 'POST') return changePassword(request, env, account);
  if (path === '/api/health' && request.method === 'POST') return health(request, env, account);
  if (path === '/api/brand' && request.method === 'PUT') return updateBrand(request, env, account);
  if (path === '/api/welcomed' && request.method === 'POST') {
    if (account.role !== 'owner') return json({ error: 'Only the owner can do this.' }, 403);
    await env.DB.prepare("INSERT OR REPLACE INTO setting(key,value) VALUES('welcomed','1')").run();
    return json({ welcomed: true });
  }
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
