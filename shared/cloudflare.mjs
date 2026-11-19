// The Cloudflare API calls the setup script (Node) and the Worker (first-run screen and Setup health) both make, so there is
// one copy of each. Every path, body and permission was read from developers.cloudflare.com on Nov 18 2026. Where the docs
// leave something open (the Email Sending permission, whether onboarding adds its own DNS records), a refusal ends the step
// with the exact dashboard step instead of a guess.

export const API = 'https://api.cloudflare.com/client/v4';

// A user-token template link: it opens the dashboard's token form with these permissions already picked. Keys are the
// documented short keys. Email Routing Rules and Email Sending have no documented key: the two entries below are best tries,
// and the dashboard silently drops a key it does not know, so the setup text tells people to check for those two by hand.
const TOKEN_PERMISSIONS = [
  { key: 'workers_scripts', type: 'edit' }, { key: 'd1', type: 'edit' }, { key: 'workers_r2', type: 'edit' },
  { key: 'account_settings', type: 'read' }, { key: 'zone', type: 'read' }, { key: 'dns', type: 'edit' },
  { key: 'zone_settings', type: 'edit' }, { key: 'workers_routes', type: 'edit' },
  { key: 'email_routing_rules', type: 'edit' }, { key: 'email_sending', type: 'edit' },
];
/** @param {string} name */
export const tokenLink = name => `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(JSON.stringify(TOKEN_PERMISSIONS))}&accountId=*&zoneId=all&name=${encodeURIComponent(name)}`;
/** The permissions the token needs, in the dashboard's words, for people checking the form or making a token by hand. */
export const TOKEN_NEEDS = [
  'Account: Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Account Settings Read, Email Sending Edit',
  'Zone: Zone Read, DNS Edit, Zone Settings Edit, Workers Routes Edit, Email Routing Rules Edit',
];

export class CloudflareError extends Error {
  /** @param {number} status @param {{ code?: number, message?: string }[]} errors */
  constructor(status, errors) {
    super(errors.map(item => [item.code, item.message].filter(Boolean).join(' ')).join('; ') || (status ? `HTTP ${status}` : 'Could not reach the Cloudflare API.'));
    this.status = status;
    this.denied = status === 401 || status === 403;
  }
}

/** A function that calls the API with this token and returns `result`; `.page()` follows `result_info` across pages. */
export function client(token) {
  const call = async (method, path, body) => {
    let response;
    try {
      response = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new CloudflareError(0, []); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new CloudflareError(response.status, data.errors || []);
    return data;
  };
  const cf = async (method, path, body) => (await call(method, path, body)).result;
  cf.page = async (path, limit = 10) => {
    const items = [];
    for (let page = 1; page <= limit; page++) {
      const data = await call('GET', `${path}${path.includes('?') ? '&' : '?'}page=${page}`);
      items.push(...(data.result || []));
      if (!data.result_info || page >= (data.result_info.total_pages || 1)) break;
    }
    return items;
  };
  return cf;
}

/** Active zones the token can see, with the account each one belongs to. GET /zones needs Zone Read. */
export async function listZones(cf) {
  const zones = await cf.page('/zones?status=active&per_page=50');
  return zones.map(zone => ({ id: zone.id, name: zone.name, accountId: zone.account?.id || '', accountName: zone.account?.name || '' }));
}

/** The zone for exactly this domain, or null. Only an active zone counts: anyone can add any domain to their own account as
 * a pending zone, but only the account whose nameservers the domain really uses gets it active. */
export async function findZone(cf, domain) {
  const zone = (await cf('GET', `/zones?name=${encodeURIComponent(domain)}`))?.[0];
  if (!zone || zone.status !== 'active') return null;
  return { id: zone.id, name: zone.name, accountId: zone.account?.id || '', accountName: zone.account?.name || '' };
}

/** The Worker serving a hostname in this account, or null. GET /accounts/{a}/workers/domains needs Workers Scripts Read. */
export async function domainService(cf, accountId, host) {
  const found = await cf('GET', `/accounts/${accountId}/workers/domains?hostname=${encodeURIComponent(host)}`);
  return (found || []).find(item => item.hostname === host) || null;
}

/** Whether a Worker named `script` in this account has ever deployed the version `versionId`.
 * GET /accounts/{a}/workers/scripts/{name}/deployments needs Workers Scripts Read; any deployment listed counts, so a secret
 * change or a deploy a moment ago (which makes a new version) does not break the check. */
export async function runsVersion(cf, accountId, script, versionId) {
  if (!script || !versionId) return false;
  try {
    const result = await cf('GET', `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/deployments`);
    return (result?.deployments || []).some(deployment => (deployment.versions || []).some(version => version.version_id === versionId));
  } catch (error) {
    if (error instanceof CloudflareError && error.status === 404) return false;
    throw error;
  }
}

// Mail providers people will recognise from their MX hosts.
const PROVIDERS = [[/(^|\.)google(mail)?\.com$/, 'Google Workspace'], [/(^|\.)outlook\.com$/, 'Microsoft 365'], [/(^|\.)zoho\.(com|eu|in)$/, 'Zoho Mail'],
  [/(^|\.)protonmail\.ch$/, 'Proton Mail'], [/(^|\.)messagingengine\.com$/, 'Fastmail'], [/(^|\.)mimecast\.com$/, 'Mimecast']];
const provider = host => { const plain = String(host || '').replace(/\.$/, '').toLowerCase(); return PROVIDERS.find(([test]) => test.test(plain))?.[1] || plain; };
const cloudflareMx = host => /\.mx\.cloudflare\.net\.?$/i.test(String(host || ''));
const ours = (rule, script) => (rule?.actions || []).some(action => action.type === 'worker' && (action.value || []).includes(script));
const describe = rule => (rule.actions || []).map(action => action.type === 'forward' ? `forwards to ${(action.value || []).join(', ')}`
  : action.type === 'worker' ? `goes to the Worker ${(action.value || []).join(', ')}` : 'is dropped').join(' and ');
const permissionOrNull = async work => { try { return await work(); } catch (error) { if (error instanceof CloudflareError && error.denied) throw error; return null; } };

/** Where the domain's mail goes now. `elsewhere` lists, in plain words, every place mail would stop going if the catch-all
 * is pointed at `script`: an outside provider's MX records (while Email Routing is off), a catch-all that forwards or goes
 * to another Worker, and address rules that forward. Empty when nothing would be redirected.
 * GET …/email/routing needs Zone Settings Read; …/rules and …/rules/catch_all need Email Routing Rules Read; dns_records needs DNS Read. */
export async function mailState(cf, zone, script) {
  const routing = await permissionOrNull(() => cf('GET', `/zones/${zone.id}/email/routing`));
  const mx = await cf('GET', `/zones/${zone.id}/dns_records?type=MX&name=${encodeURIComponent(zone.name)}`) || [];
  const catchAll = await permissionOrNull(() => cf('GET', `/zones/${zone.id}/email/routing/rules/catch_all`));
  const rules = ((await permissionOrNull(() => cf('GET', `/zones/${zone.id}/email/routing/rules?per_page=50`))) || [])
    .filter(rule => rule.enabled && !(rule.matchers || []).some(matcher => matcher.type === 'all'));
  const elsewhere = [];
  const outside = mx.filter(record => !cloudflareMx(record.content));
  if (!routing?.enabled && outside.length) elsewhere.push(`Mail for ${zone.name} is delivered to ${[...new Set(outside.map(record => provider(record.content)))].join(', ')} (its MX records).`);
  const catchAllOn = Boolean(catchAll?.enabled), catchAllOurs = catchAllOn && ours(catchAll, script);
  if (catchAllOn && !catchAllOurs && (catchAll.actions || []).some(action => action.type !== 'drop')) elsewhere.push(`Email Routing's catch-all rule: mail ${describe(catchAll)}.`);
  const away = rules.filter(rule => !ours(rule, script));
  if (away.length) elsewhere.push(`${away.length} Email Routing address rule${away.length === 1 ? '' : 's'} (these keep working and win over the catch-all): ${away.slice(0, 3).map(rule => `${(rule.matchers || []).map(matcher => matcher.value).filter(Boolean).join(', ')} ${describe(rule)}`).join('; ')}${away.length > 3 ? '; …' : ''}.`);
  return { routingOn: Boolean(routing?.enabled), routingStatus: routing?.status || (routing?.enabled ? 'ready' : 'off'), catchAllOurs, away: away.length, elsewhere };
}

/** The sending domain and the DNS records it still lacks. GET …/email/sending/subdomains[/{tag}/dns]; no permission is documented. */
export async function sendingState(cf, zone) {
  const sender = ((await cf('GET', `/zones/${zone.id}/email/sending/subdomains`)) || []).find(item => item.name === zone.name) || null;
  if (!sender?.tag) return { onboarded: false, enabled: false, tag: '', missing: [] };
  return { onboarded: true, enabled: sender.enabled !== false, tag: sender.tag, missing: await missingRecords(cf, zone, sender.tag) };
}

const unquote = value => String(value || '').replace(/^"|"$/g, '').replace(/"\s+"/g, '');
const absolute = (name, domain) => { const plain = String(name || '').replace(/\.$/, '').toLowerCase(); return !plain || plain === '@' ? domain : plain === domain || plain.endsWith(`.${domain}`) ? plain : `${plain}.${domain}`; };
async function missingRecords(cf, zone, tag) {
  const wanted = await cf('GET', `/zones/${zone.id}/email/sending/subdomains/${tag}/dns`) || [], missing = [];
  for (const record of wanted) {
    if (!record.type || !record.content) continue;
    const name = absolute(record.name, zone.name);
    const existing = await cf('GET', `/zones/${zone.id}/dns_records?type=${record.type}&name=${encodeURIComponent(name)}`) || [];
    if (existing.some(item => unquote(item.content) === unquote(record.content))) continue;
    // Cloudflare adds DMARC only where none exists; an existing policy is the owner's to keep.
    if (record.type === 'TXT' && name.startsWith('_dmarc.') && existing.length) continue;
    missing.push({ type: record.type, name, content: record.content, ...(record.priority !== undefined ? { priority: record.priority } : {}) });
  }
  return missing;
}

/** What each step does, in one line, the permission it needs, and the dashboard step that does the same by hand. */
export const STEPS = {
  site: { doing: c => `Putting ${c.product} on https://${c.host}`, needs: 'Workers Scripts Edit and Workers Routes Edit',
    dashboard: c => `Workers & Pages > ${c.script} > Settings > Domains & Routes > Add > Custom domain > ${c.host}. If Cloudflare says the name already has a DNS record, delete that record (DNS > Records) or choose another web address.` },
  routing: { doing: c => `Turning on Email Routing for ${c.domain}`, needs: 'Zone Settings Edit',
    dashboard: c => `Compute > Email Service > Email Routing > Onboard Domain > ${c.domain}. Cloudflare adds and locks its MX and SPF records.` },
  catchAll: { doing: c => `Sending all mail for ${c.domain} to ${c.product}`, needs: 'Email Routing Rules Edit',
    dashboard: c => `Compute > Email Service > Email Routing > ${c.domain} > Routing rules > Catch-all: action "Send to a Worker", destination ${c.script}, then make it Active.` },
  sending: { doing: c => `Setting up ${c.domain} to send mail`, needs: 'Email Sending Edit and DNS Edit',
    dashboard: c => `Compute > Email Service > Email Sending > Onboard Domain > ${c.domain}, and keep the records it adds.` },
};

/** A step's failure in plain words: what went wrong and the one thing to do. */
export function explain(key, error, c) {
  const step = STEPS[key], detail = error instanceof Error ? error.message : String(error);
  if (error instanceof CloudflareError && error.denied)
    return { problem: `The Cloudflare token is not allowed to do this (${detail}).`, fix: `Add ${step.needs} to the token and try again, or do it in the dashboard: ${step.dashboard(c)}` };
  if (error instanceof CloudflareError && error.status === 0) return { problem: 'Could not reach the Cloudflare API.', fix: 'Check the internet connection and try again.' };
  return { problem: detail, fix: `Do it in the Cloudflare dashboard: ${step.dashboard(c)}` };
}

/** Where things stand for this install, as a list the setup script and the Setup health panel both show.
 * c: { product, domain, host, script, accountId, zone }. Each item: { key, ok, label, detail?, fix? }. */
export async function inspect(cf, c) {
  const items = [];
  const item = (key, ok, label, detail = '') => items.push({ key, ok, label, ...(detail ? { detail } : {}), ...(ok ? {} : { fix: STEPS[key] ? STEPS[key].dashboard(c) : '' }) });
  const guard = async (key, label, work) => { try { await work(); } catch (error) { const { problem, fix } = explain(key, error, c); items.push({ key, ok: false, label, detail: problem, fix }); } };
  if (c.host) await guard('site', `https://${c.host} opens ${c.product}`, async () => {
    const found = await domainService(cf, c.accountId, c.host);
    item('site', found?.service === c.script, `https://${c.host} opens ${c.product}`, !found ? 'Not set up yet.' : found.service !== c.script ? `It opens the Worker ${found.service} instead.` : '');
  });
  await guard('routing', `Mail for ${c.domain} comes in`, async () => {
    const state = await mailState(cf, c.zone, c.script);
    item('routing', state.routingOn && state.routingStatus === 'ready', `Email Routing is on for ${c.domain}`, state.routingOn ? (state.routingStatus === 'ready' ? '' : `Cloudflare reports it as ${state.routingStatus}.`) : 'It is off.');
    item('catchAll', state.catchAllOurs, `All mail for ${c.domain} comes to ${c.product}`, state.catchAllOurs ? (state.away ? `${state.away} address rule${state.away === 1 ? '' : 's'} still send${state.away === 1 ? 's' : ''} some addresses elsewhere.` : '') : (state.elsewhere.join(' ') || 'The catch-all rule does not point here.'));
  });
  await guard('sending', `${c.domain} can send mail`, async () => {
    const state = await sendingState(cf, c.zone);
    item('sending', state.onboarded && state.enabled && !state.missing.length, `${c.domain} can send mail`,
      !state.onboarded ? 'It is not set up for sending.' : !state.enabled ? 'Sending is turned off for it.' : state.missing.length ? `${state.missing.length} of its DNS records are missing.` : '');
  });
  return items;
}

/** Makes every red item green, in order, stopping at the first failure. It never redirects mail on its own: when
 * `mailState` finds mail going somewhere else, it returns `{ confirm }` unless `confirmed` is the domain, typed. `say` is
 * called with each step's one line before it runs. Returns `{ done: string[], failed?: { key, problem, fix }, confirm?: string[] }`. */
export async function repair(cf, c, { confirmed = '', say = () => {} } = {}) {
  const done = [];
  const run = async (key, work) => {
    say(STEPS[key].doing(c));
    try { const changed = await work(); done.push(key); return { changed }; }
    catch (error) { return { failed: { key, ...explain(key, error, c) } }; }
  };
  let state;
  try { state = await mailState(cf, c.zone, c.script); } catch (error) { return { done, failed: { key: 'routing', ...explain('routing', error, c) } }; }
  if (!state.catchAllOurs && state.elsewhere.length && confirmed.trim().toLowerCase() !== c.domain) return { done, confirm: state.elsewhere };
  const routing = await run('routing', async () => {
    if (state.routingOn) return false;
    // The documented "Enable Email Routing": adds and locks the MX and SPF records. Needs Zone Settings Write.
    await cf('POST', `/zones/${c.zone.id}/email/routing/dns`, { name: c.domain });
    return true;
  });
  if (routing.failed) return { done, failed: routing.failed };
  const catchAll = await run('catchAll', async () => {
    if (state.catchAllOurs) return false;
    // Needs Email Routing Rules Write. wrangler.json has no `addresses`, so deploys never fight over this rule.
    await cf('PUT', `/zones/${c.zone.id}/email/routing/rules/catch_all`, { name: `${c.product}: all mail`, enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: [c.script] }] });
    return true;
  });
  if (catchAll.failed) return { done, failed: catchAll.failed };
  const sending = await run('sending', async () => {
    let tag = (await sendingState(cf, c.zone)).tag, changed = false;
    if (!tag) { tag = (await cf('POST', `/zones/${c.zone.id}/email/sending/subdomains`, { name: c.domain }))?.tag; changed = true; }
    if (!tag) throw new Error('Cloudflare did not return the sending domain.');
    // The docs don't say whether onboarding adds these records itself, as the dashboard does, so any still missing are added.
    for (const record of await missingRecords(cf, c.zone, tag)) { await cf('POST', `/zones/${c.zone.id}/dns_records`, { ...record, ttl: 1 }); changed = true; }
    return changed;
  });
  if (sending.failed) return { done, failed: sending.failed };
  // Last, because a clash with an existing DNS record is the likeliest failure and should not hold up mail.
  if (c.host) {
    const site = await run('site', async () => {
      const found = await domainService(cf, c.accountId, c.host);
      if (found?.service === c.script) return false;
      if (found) throw new Error(`https://${c.host} already opens another Worker, ${found.service}. Choose another web address, or remove it from ${found.service} first.`);
      // PUT /accounts/{a}/workers/domains {hostname, service, zone_id} needs Workers Scripts Write.
      await cf('PUT', `/accounts/${c.accountId}/workers/domains`, { hostname: c.host, service: c.script, zone_id: c.zone.id });
      return true;
    });
    if (site.failed) return { done, failed: site.failed };
  }
  return { done };
}
