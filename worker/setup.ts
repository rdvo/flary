import { client, domainService, findZone, inspect, listZones, mailState, repair, runsVersion, CloudflareError, type Cf, type Context, type Zone } from '../shared/cloudflare.mjs';
import { hasAccounts, passwordHash, type Account } from './auth';
import { DOMAIN_RE, PRODUCT, changed, cleanName, json, localPart, readJson, sha, type Bindings, type Env } from './util';

/* The first-run screen and the owner's Setup health panel.
 *
 * Who may claim a fresh install. Until the owner exists, anyone who finds the address can open the first-run screen, so it
 * accepts exactly two proofs that the visitor controls the Cloudflare account this Worker runs in:
 *
 * 1. The SETUP_TOKEN secret. `npm run setup` stores a random one and puts it in the link it prints; whoever ran it already
 *    controls the account. Anyone can also add one by hand in the dashboard as a fallback.
 * 2. A Cloudflare API token, checked in two parts, both against Cloudflare's own records:
 *    a. The token can see the chosen domain as an *active* zone. Anyone can add any domain to their own account, but it
 *       stays pending; only the account whose nameservers the domain really uses gets it active.
 *    b. In that same account, the Worker serving the address this request came in on has deployed the exact version that is
 *       answering it. The version id comes from the version-metadata binding: a random id Cloudflare gives each upload,
 *       never sent to the browser, and impossible to give an upload in another account.
 *    A stranger's token only reaches the stranger's account, where no Worker has deployed this version, so (b) fails
 *    whatever domain they name; and (a) ties the domain to that same account, so an owner can't point the install at a
 *    domain they don't control either. The token is used for the one request and is never stored or logged.
 * Every attempt counts toward a rate limit (10 per visitor per 15 minutes, 60 in all per hour), so the screen can't be used
 * to test stolen tokens at speed. Once the owner exists, these endpoints answer 404 for good. */

let knownDomain = '';
/** The mail domain: the setup script's DOMAIN variable, else the one picked on the first-run screen (kept in `setting`). */
export async function withDomain(bindings: Bindings): Promise<Env> {
  if (!bindings.DOMAIN && !knownDomain) knownDomain = (await bindings.DB.prepare("SELECT value FROM setting WHERE key='domain'").first<string>('value')) || '';
  return { ...bindings, DOMAIN: (bindings.DOMAIN || knownDomain).trim().toLowerCase() };
}

const gone = () => json({ error: 'Not found.' }, 404);
const MINUTE = 60_000;

/** Counts this attempt; false when the visitor or everyone together has tried too often lately. */
async function allowed(request: Request, env: Env) {
  const now = Date.now(), who = await sha(`${PRODUCT}:${request.headers.get('cf-connecting-ip') || 'unknown'}`);
  const [mine, all] = await env.DB.batch<{ n: number }>([
    env.DB.prepare('SELECT COUNT(*) AS n FROM setup_attempt WHERE who=?1 AND at>?2').bind(who, now - 15 * MINUTE),
    env.DB.prepare('SELECT COUNT(*) AS n FROM setup_attempt WHERE at>?1').bind(now - 60 * MINUTE),
  ]);
  if ((mine.results[0]?.n ?? 0) >= 10 || (all.results[0]?.n ?? 0) >= 60) return false;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO setup_attempt(who,at) VALUES(?1,?2)').bind(who, now),
    env.DB.prepare('DELETE FROM setup_attempt WHERE at<?1').bind(now - 1440 * MINUTE),
  ]);
  return true;
}
const slowDown = () => json({ error: 'Too many tries. Wait 15 minutes, then try again.' }, 429);

/** The Worker this request reached, when it is in `accountId` and running this very version; otherwise null. */
async function selfIn(cf: Cf, accountId: string, request: Request, env: Env) {
  const host = new URL(request.url).hostname;
  const script = host.endsWith('.workers.dev') ? host.split('.')[0] : (await domainService(cf, accountId, host))?.service;
  return script && await runsVersion(cf, accountId, script, env.CF_VERSION_METADATA?.id ?? '') ? script : null;
}

/** A Cloudflare failure in words for the screen. */
function cloudflareProblem(error: unknown) {
  if (error instanceof CloudflareError && error.status === 401) return json({ error: 'Cloudflare did not accept that token. Copy it again, the whole thing, or make a new one with the link.' }, 400);
  if (error instanceof CloudflareError && error.denied) return json({ error: `That token is missing a permission (${error.message}). Make one with the link, which picks them all.` }, 400);
  if (error instanceof CloudflareError) return json({ error: `Cloudflare answered: ${error.message}` }, 502);
  throw error;
}
const notThisAccount = () => json({ error: `That token is for a different Cloudflare account from the one running this site, or the token can’t read Workers. Use a token for the account where you deployed ${PRODUCT}, made with the link.` }, 403);
const noVersionBinding = () => json({ error: 'This copy cannot check a Cloudflare token (its wrangler.json has no version_metadata). Use a setup code instead: in the Cloudflare dashboard add a secret named SETUP_TOKEN to this Worker, then choose “I have a setup code”.' }, 503);

/** POST /api/setup/check {cfToken}: the domains this token can set up here, so the screen offers a list instead of a box. */
export async function checkToken(request: Request, env: Env) {
  if (await hasAccounts(env)) return gone();
  if (!env.CF_VERSION_METADATA?.id) return noVersionBinding();
  if (!await allowed(request, env)) return slowDown();
  const input = await readJson<{ cfToken: string }>(request), cf = client(String(input.cfToken || '').trim());
  try {
    const zones = await listZones(cf);
    if (!zones.length) return json({ error: 'That token can’t see any active domain. Make one with the link, and make sure the domain’s DNS is on Cloudflare and shows Active.' }, 400);
    const accounts = [...new Set(zones.map(zone => zone.accountId))].slice(0, 5);
    for (const accountId of accounts) {
      const script = await selfIn(cf, accountId, request, env);
      if (!script) continue;
      const names = zones.filter(zone => zone.accountId === accountId).map(zone => zone.name).filter(name => !env.DOMAIN || name === env.DOMAIN);
      if (!names.length) return json({ error: `This site was set up for ${env.DOMAIN}, and that token can’t see it.` }, 400);
      return json({ domains: names, host: new URL(request.url).hostname });
    }
    return notThisAccount();
  } catch (error) { return cloudflareProblem(error); }
}

/** Creates the owner, and saves the domain with it, in one transaction that does nothing if any account exists. */
async function createOwner(env: Env, owner: { local: string; name: string; password: string }, domain: string) {
  const address = `${owner.local}@${domain}`, mailboxId = crypto.randomUUID(), accountId = crypto.randomUUID(), now = Date.now(), none = 'NOT EXISTS (SELECT 1 FROM account)';
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT OR REPLACE INTO setting(key,value) SELECT 'domain',?1 WHERE ${none}`).bind(domain),
    env.DB.prepare(`INSERT INTO mailbox(id,address,name,kind,created_at) SELECT ?1,?2,?3,'personal',?4 WHERE ${none}`).bind(mailboxId, address, owner.name, now),
    env.DB.prepare(`INSERT INTO account(id,mailbox_id,name,role,password,must_change,created_at) SELECT ?1,?2,?3,'owner',?4,0,?5 WHERE ${none}`).bind(accountId, mailboxId, owner.name, await passwordHash(owner.password), now),
    env.DB.prepare('INSERT INTO mailbox_member(mailbox_id,account_id) SELECT ?1,?2 WHERE EXISTS (SELECT 1 FROM account WHERE id=?2)').bind(mailboxId, accountId),
  ]);
  if (!changed(results[2])) return null;
  if (!env.DOMAIN) knownDomain = domain;
  return address;
}

const hostFor = (value: unknown, domain: string) => {
  const host = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') || `mail.${domain}`;
  return (host === domain || host.endsWith(`.${domain}`)) && DOMAIN_RE.test(host) ? host : null;
};

/** POST /api/setup: create the owner account. With a setup code, that is all (the setup script did the rest). With a
 * Cloudflare token, it also turns on mail in and out and puts the site on its web address, and reports each step. */
export async function firstRun(request: Request, env: Env) {
  if (await hasAccounts(env)) return gone();
  if (!await allowed(request, env)) return slowDown();
  const input = await readJson<{ setupToken: string; cfToken: string; domain: string; host: string; confirmed: string; address: string; name: string; password: string }>(request);
  const owner = { local: localPart(input.address) || '', name: cleanName(input.name), password: String(input.password || '') };
  if (!owner.local) return json({ error: 'Use letters, numbers, dots, dashes or underscores before the @.' }, 400);
  if (!owner.name) return json({ error: 'Add your name.' }, 400);
  if (owner.password.length < 10 || owner.password.length > 200) return json({ error: 'Choose a password of at least 10 characters.' }, 400);

  if (input.setupToken) {
    if (!env.SETUP_TOKEN) return json({ error: 'This site has no setup code. Use a Cloudflare token instead, or add a secret named SETUP_TOKEN to this Worker in the dashboard.' }, 403);
    const digest = (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value.trim()));
    if (!crypto.subtle.timingSafeEqual(await digest(String(input.setupToken)), await digest(env.SETUP_TOKEN))) return json({ error: 'That setup code isn’t right. Open the link the setup script printed, or run it again for a new one.' }, 403);
    if (!env.DOMAIN) return json({ error: 'This site doesn’t know its domain yet. Use a Cloudflare token instead of a setup code.' }, 400);
    const address = await createOwner(env, owner, env.DOMAIN);
    return address ? json({ created: true, address, done: [] }) : gone();
  }

  if (!env.CF_VERSION_METADATA?.id) return noVersionBinding();
  const domain = String(input.domain || '').trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) return json({ error: 'Pick your domain.' }, 400);
  if (env.DOMAIN && domain !== env.DOMAIN) return json({ error: `This site was set up for ${env.DOMAIN}.` }, 400);
  const host = hostFor(input.host, domain);
  if (!host) return json({ error: `The web address must be ${domain} or a name under it, like mail.${domain}.` }, 400);
  const cf = client(String(input.cfToken || '').trim());
  let c: Context;
  try {
    const zone: Zone | null = await findZone(cf, domain);
    if (!zone) return json({ error: `That token can’t see ${domain} as an active domain on Cloudflare.` }, 400);
    const script = await selfIn(cf, zone.accountId, request, env);
    if (!script) return notThisAccount();
    c = { product: PRODUCT, domain, host, script, accountId: zone.accountId, zone };
    // Never redirect a domain's mail without the owner typing the domain: ask before the account exists, so they can stop.
    const state = await mailState(cf, zone, script);
    if (!state.catchAllOurs && state.elsewhere.length && String(input.confirmed || '').trim().toLowerCase() !== domain) return json({ confirm: state.elsewhere }, 409);
  } catch (error) { return cloudflareProblem(error); }
  const address = await createOwner(env, owner, domain);
  if (!address) return gone();
  // The account exists from here on; a step that fails is reported with its fix, and Setup health can finish it later.
  const result = await repair(cf, c, { confirmed: domain }).catch(error => ({ done: [], failed: { key: 'routing' as const, problem: error instanceof Error ? error.message : 'Something went wrong.', fix: 'Open Setup health in the org panel after signing in, and check again.' } }));
  return json({ created: true, address, url: `https://${host}`, ...result });
}

/** POST /api/health {cfToken, host?, fix?, confirmed?}, owner only: is mail coming in and going out, and (with `fix`) set
 * right whatever is not. The token is used for this one request, as on the first-run screen. */
export async function health(request: Request, env: Env, account: Account) {
  if (account.role !== 'owner') return json({ error: 'Only the owner can check this.' }, 403);
  const input = await readJson<{ cfToken: string; host: string; fix: boolean; confirmed: string }>(request), domain = env.DOMAIN;
  const here = new URL(request.url).hostname, host = hostFor(input.host || (here.endsWith('.workers.dev') ? '' : here), domain);
  if (!host) return json({ error: `The web address must be ${domain} or a name under it.` }, 400);
  if (!env.CF_VERSION_METADATA?.id) return noVersionBinding();
  const cf = client(String(input.cfToken || '').trim());
  try {
    const zone = await findZone(cf, domain);
    if (!zone) return json({ error: `That token can’t see ${domain} as an active domain on Cloudflare.` }, 400);
    const script = await selfIn(cf, zone.accountId, request, env);
    if (!script) return notThisAccount();
    const c: Context = { product: PRODUCT, domain, host, script, accountId: zone.accountId, zone };
    const result = input.fix ? await repair(cf, c, { confirmed: String(input.confirmed || '') }) : null;
    if (result?.confirm) return json({ confirm: result.confirm }, 409);
    return json({ host, items: await inspect(cf, c), ...(result?.failed ? { failed: result.failed } : {}) });
  } catch (error) { return cloudflareProblem(error); }
}
