import { client, domainService, findZone, inspect, listZones, mailState, repair, runsVersion, CloudflareError, type Cf, type Context, type Zone } from '../shared/cloudflare.mjs';
import { hasAccounts, passwordHash, type Account } from './auth';
import { badLogo, readLogo, saveLogo, settings } from './brand';
import { DOMAIN_RE, PRODUCT, changed, cleanName, json, localPart, readJson, sha, type Bindings, type Env } from './util';

/* The setup wizard and the owner's Setup health panel.
 *
 * Who may run the wizard. Until the owner exists, anyone who finds the address can open it, so it accepts exactly two
 * proofs that the visitor controls the Cloudflare account this Worker runs in:
 *
 * 1. The SETUP_TOKEN secret. `npm run setup` stores a random one and puts it in the link it prints; whoever ran it already
 *    controls the account. The installer also stores its Cloudflare token as CF_API_TOKEN, which the wizard then uses.
 * 2. A Cloudflare API token pasted in the wizard (a Deploy-button install has no installer), checked in two parts, both
 *    against Cloudflare's own records:
 *    a. The token can see the chosen domain as an *active* zone. Anyone can add any domain to their own account, but it
 *       stays pending; only the account whose nameservers the domain really uses gets it active.
 *    b. In that same account, the Worker serving the address this request came in on has deployed the exact version that is
 *       answering it. The version id comes from the version-metadata binding: a random id Cloudflare gives each upload,
 *       never sent to the browser, and impossible to give an upload in another account.
 *    A stranger's token only reaches the stranger's account, where no Worker has deployed this version, so (b) fails
 *    whatever domain they name; and (a) ties the domain to that same account. A pasted token that passes is then kept as
 *    CF_API_TOKEN, like the installer's.
 * Every attempt counts toward a rate limit (10 per visitor per 15 minutes, 60 in all per hour), so the wizard can't be used
 * to test stolen tokens at speed. Once the owner exists, these endpoints answer 404 for good.
 *
 * The kept token never leaves the Worker. Nothing sends it to a browser, and the only things done with it are the fixed
 * steps in shared/cloudflare.mjs, for the owner. */

let knownDomain = '';
/** The mail domain: a DOMAIN variable if one is set, else the one picked in the wizard (kept in `setting`). */
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
const notThisAccount = () => json({ error: `That token is for a different Cloudflare account from the one running this site, or the token can’t read Workers. Use a token for the account where you installed ${PRODUCT}, made with the link.` }, 403);
const noVersionBinding = () => json({ error: 'This copy cannot check a Cloudflare token (its wrangler.json has no version_metadata). Install it again with `npm run setup`.' }, 503);

/** Stores the Cloudflare token on this Worker as the secret CF_API_TOKEN. PUT …/scripts/{name}/secrets needs Workers Scripts Edit. */
export const keepToken = (cf: Cf, accountId: string, script: string, token: string) =>
  cf('PUT', `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/secrets`, { name: 'CF_API_TOKEN', text: token, type: 'secret_text' });

type Proof = { cf: Cf; token: string; kept: boolean; accountId: string; script: string; zones: Zone[] };

/** Checks one of the two proofs and finds this Worker's account and the active domains in it. A Response means no. */
async function prove(request: Request, env: Env, input: { setupToken?: unknown; cfToken?: unknown }): Promise<Proof | Response> {
  if (!env.CF_VERSION_METADATA?.id) return noVersionBinding();
  let token = String(input.cfToken || '').trim(), kept = false;
  if (input.setupToken) {
    if (!env.SETUP_TOKEN) return json({ error: 'This site has no setup code. Paste a Cloudflare API token instead.' }, 403);
    const digest = (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value.trim()));
    if (!crypto.subtle.timingSafeEqual(await digest(String(input.setupToken)), await digest(env.SETUP_TOKEN))) return json({ error: 'That setup code isn’t right. Open the link the installer printed, or run `npm run setup` again for a new one.' }, 403);
    if (!env.CF_API_TOKEN) return json({ error: 'This site has no Cloudflare token kept yet. Paste one instead.' }, 400);
    token = env.CF_API_TOKEN; kept = true;
  }
  if (!token) return json({ error: 'Paste a Cloudflare API token.' }, 400);
  const cf = client(token);
  try {
    const zones = await listZones(cf);
    if (!zones.length) return json({ error: 'That token can’t see any active domain. Make sure the domain’s DNS is on Cloudflare and shows Active, and that the token was made with the link.' }, 400);
    for (const accountId of [...new Set(zones.map(zone => zone.accountId))].slice(0, 5)) {
      const script = await selfIn(cf, accountId, request, env);
      if (script) return { cf, token, kept, accountId, script, zones: zones.filter(zone => zone.accountId === accountId && (!env.DOMAIN || zone.name === env.DOMAIN)) };
    }
    return notThisAccount();
  } catch (error) { return cloudflareProblem(error); }
}

/** POST /api/setup/check {setupToken | cfToken}: the domains this install can use, so the wizard offers a list. */
export async function checkToken(request: Request, env: Env) {
  if (await hasAccounts(env)) return gone();
  if (!await allowed(request, env)) return slowDown();
  const proof = await prove(request, env, await readJson<{ setupToken: string; cfToken: string }>(request));
  if (proof instanceof Response) return proof;
  if (!proof.zones.length) return json({ error: env.DOMAIN ? `This site was set up for ${env.DOMAIN}, and the token can’t see it.` : 'No active domain was found in this Cloudflare account.' }, 400);
  return json({ domains: proof.zones.map(zone => zone.name).sort() });
}

/** Creates the owner, and saves the domain, web address and organisation name with it, in one transaction that does nothing
 * if any account exists. */
async function createOwner(env: Env, owner: { local: string; name: string; password: string }, saved: { domain: string; host: string; org: string }) {
  const address = `${owner.local}@${saved.domain}`, mailboxId = crypto.randomUUID(), accountId = crypto.randomUUID(), now = Date.now(), none = 'NOT EXISTS (SELECT 1 FROM account)';
  const setting = (key: string, value: string) => env.DB.prepare(`INSERT OR REPLACE INTO setting(key,value) SELECT ?1,?2 WHERE ${none}`).bind(key, value);
  const results = await env.DB.batch([
    setting('domain', saved.domain), setting('host', saved.host), setting('org_name', saved.org),
    env.DB.prepare(`INSERT INTO mailbox(id,address,name,kind,created_at) SELECT ?1,?2,?3,'personal',?4 WHERE ${none}`).bind(mailboxId, address, owner.name, now),
    env.DB.prepare(`INSERT INTO account(id,mailbox_id,name,role,password,must_change,created_at) SELECT ?1,?2,?3,'owner',?4,0,?5 WHERE ${none}`).bind(accountId, mailboxId, owner.name, await passwordHash(owner.password), now),
    env.DB.prepare('INSERT INTO mailbox_member(mailbox_id,account_id) SELECT ?1,?2 WHERE EXISTS (SELECT 1 FROM account WHERE id=?2)').bind(mailboxId, accountId),
  ]);
  if (!changed(results[4])) return null;
  if (!env.DOMAIN) knownDomain = saved.domain;
  return address;
}

const hostFor = (value: unknown, domain: string) => {
  const host = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') || `mail.${domain}`;
  return (host === domain || host.endsWith(`.${domain}`)) && DOMAIN_RE.test(host) ? host : null;
};

/** POST /api/setup: the wizard's last step. Creates the owner with the organisation's name and logo, turns on mail in and
 * out, puts the site on its web address, keeps the token, and reports each step. */
export async function firstRun(request: Request, env: Env) {
  if (await hasAccounts(env)) return gone();
  if (!await allowed(request, env)) return slowDown();
  const input = await readJson<{ setupToken: string; cfToken: string; domain: string; host: string; confirmed: string; org: string; logo: string; address: string; name: string; password: string }>(request);
  const owner = { local: localPart(input.address) || '', name: cleanName(input.name), password: String(input.password || '') }, org = cleanName(input.org);
  if (!org) return json({ error: 'Add your organisation’s name.' }, 400);
  const logo = input.logo ? readLogo(input.logo) : null;
  if (logo === 'bad') return badLogo();
  if (!owner.local) return json({ error: 'Use letters, numbers, dots, dashes or underscores before the @.' }, 400);
  if (!owner.name) return json({ error: 'Add your name.' }, 400);
  if (owner.password.length < 10 || owner.password.length > 200) return json({ error: 'Choose a password of at least 10 characters.' }, 400);

  const proof = await prove(request, env, input);
  if (proof instanceof Response) return proof;
  const domain = String(input.domain || '').trim().toLowerCase(), zone = proof.zones.find(item => item.name === domain);
  if (!zone) return json({ error: 'Pick your domain from the list.' }, 400);
  const host = hostFor(input.host, domain);
  if (!host) return json({ error: `The web address must be ${domain} or a name under it, like mail.${domain}.` }, 400);
  const c: Context = { product: PRODUCT, domain, host, script: proof.script, accountId: proof.accountId, zone };
  try {
    // Never redirect a domain's mail without the owner typing the domain: ask before the account exists, so they can stop.
    const state = await mailState(proof.cf, zone, proof.script);
    if (!state.catchAllOurs && state.elsewhere.length && String(input.confirmed || '').trim().toLowerCase() !== domain) return json({ confirm: state.elsewhere }, 409);
  } catch (error) { return cloudflareProblem(error); }

  const address = await createOwner(env, owner, { domain, host, org });
  if (!address) return gone();
  // The account exists from here on; a step that fails is reported with its fix, and Setup health can finish it later.
  if (logo) await saveLogo(env, logo);
  const result = await repair(proof.cf, c, { confirmed: domain }).catch(error => ({ done: [], failed: { key: 'routing' as const, problem: error instanceof Error ? error.message : 'Something went wrong.', fix: 'Open Setup health in the org panel after signing in, and check again.' } }));
  let kept = proof.kept;
  if (!kept) kept = await keepToken(proof.cf, proof.accountId, proof.script, proof.token).then(() => true, () => false);
  return json({ created: true, address, url: `https://${host}`, kept, ...result });
}

/** POST /api/health {cfToken?, host?, fix?, confirmed?}, owner only: is mail coming in and going out, and (with `fix`) set
 * right whatever is not. It uses the kept token unless one is pasted; a pasted token that works is kept in its place. */
export async function health(request: Request, env: Env, account: Account) {
  if (account.role !== 'owner') return json({ error: 'Only the owner can check this.' }, 403);
  if (!env.CF_VERSION_METADATA?.id) return noVersionBinding();
  const input = await readJson<{ cfToken: string; host: string; fix: boolean; confirmed: string }>(request), domain = env.DOMAIN;
  const pasted = String(input.cfToken || '').trim(), token = pasted || env.CF_API_TOKEN || '';
  if (!token) return json({ error: 'Paste a Cloudflare API token to check.' }, 400);
  const host = hostFor(input.host || (await settings(env)).host, domain);
  if (!host) return json({ error: `The web address must be ${domain} or a name under it.` }, 400);
  const cf = client(token);
  try {
    const zone = await findZone(cf, domain);
    if (!zone) return json({ error: `The token can’t see ${domain} as an active domain on Cloudflare.` }, 400);
    const script = await selfIn(cf, zone.accountId, request, env);
    if (!script) return notThisAccount();
    if (pasted) await keepToken(cf, zone.accountId, script, pasted).catch(() => null);
    await env.DB.prepare("INSERT OR REPLACE INTO setting(key,value) VALUES('host',?1)").bind(host).run();
    const c: Context = { product: PRODUCT, domain, host, script, accountId: zone.accountId, zone };
    const result = input.fix ? await repair(cf, c, { confirmed: String(input.confirmed || '') }) : null;
    if (result?.confirm) return json({ confirm: result.confirm }, 409);
    return json({ host, items: await inspect(cf, c), ...(result?.failed ? { failed: result.failed } : {}) });
  } catch (error) { return cloudflareProblem(error); }
}
