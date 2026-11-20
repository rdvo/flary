// What `npm run setup` and `npm run recover-owner` share: signing in to Cloudflare, prompts, the one way to stop, finding the
// account, and reading DNS records from the domain's own nameservers.
import { spawnSync } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { env, exit, platform, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { CloudflareError, listZones } from '../shared/cloudflare.mjs';

/** The one way these scripts stop: what went wrong, and the one thing to do about it. */
export const stop = (problem, fix) => { console.error(`\n✗ ${problem}\n  To fix: ${fix}\n`); exit(1); };

// A fresh prompt each time, closed after, so commands run in between get the terminal to themselves.
export const ask = async (question, fallback = '') => {
  const rl = createInterface({ input: stdin, output: stdout });
  try { return (await rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback; } finally { rl.close(); }
};

/** Asks without echoing what is typed or pasted. When the input is not a terminal (piped in), there is nothing to hide, so
 * it reads one plain line. */
export const askHidden = async question => {
  if (!stdin.isTTY) return ask(question);
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  stdout.write(`${question}: `);
  rl._writeToOutput = () => {};
  try { return (await rl.question('')).trim(); } finally { rl.close(); stdout.write('\n'); }
};

/** The Cloudflare account to use: CLOUDFLARE_ACCOUNT_ID if set, the only one the sign-in reaches, or one picked from a list.
 * GET /accounts lists the accounts it reaches; if that is refused, the accounts of the domains it sees are used. */
export async function pickAccount(cf, saved) {
  let accounts = [];
  try { accounts = (await cf.page('/accounts?per_page=50')).map(item => ({ id: item.id, name: item.name })); }
  catch (error) {
    if (error instanceof CloudflareError && error.status === 0) stop('Could not reach the Cloudflare API.', 'Check the internet connection and run it again.');
    if (error instanceof CloudflareError && error.status === 401) stop('Cloudflare did not accept the sign-in.', 'Run `npx wrangler login` and choose Allow (or check CLOUDFLARE_API_TOKEN, if you set one), then run it again.');
  }
  if (!accounts.length) {
    const zones = await listZones(cf).catch(() => []);
    accounts = [...new Map(zones.map(zone => [zone.accountId, { id: zone.accountId, name: zone.accountName }])).values()];
  }
  if (!accounts.length) stop('This sign-in cannot see any Cloudflare account.', 'Run `npx wrangler login` and choose Allow, then run it again.');
  const wanted = env.CLOUDFLARE_ACCOUNT_ID || '';
  if (wanted) return accounts.find(item => item.id === wanted) || stop(`This sign-in cannot reach the account ${wanted}.`, 'Unset CLOUDFLARE_ACCOUNT_ID, or sign in to that account.');
  if (accounts.length === 1) return accounts[0];
  accounts.sort((a, b) => a.name.localeCompare(b.name));
  console.log(accounts.map((item, index) => `  ${index + 1}. ${item.name}`).join('\n'));
  const fallback = accounts.findIndex(item => item.id === saved?.accountId) + 1;
  const picked = await ask('Which Cloudflare account (number)', fallback ? String(fallback) : '');
  return accounts[Number(picked) - 1] || stop(`"${picked || 'nothing'}" is not a number from the list.`, 'Run it again and type a number from the list.');
}

/** Runs wrangler from this project. Without CLOUDFLARE_API_TOKEN it uses wrangler's own sign-in. */
export const runWrangler = (root, args, extraEnv = {}, inherit = false) => {
  const result = spawnSync('npx', ['--no-install', 'wrangler', ...args], { cwd: root, encoding: 'utf8', shell: platform === 'win32',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], env: { ...env, WRANGLER_SEND_METRICS: 'false', ...extraEnv } });
  return { ok: result.status === 0, out: `${result.stdout || ''}${result.stderr || ''}` };
};

/** Signs in to Cloudflare. A CLOUDFLARE_API_TOKEN in the environment is used as it is. Otherwise it is wrangler's own sign-in
 * (Cloudflare's consent page in the browser, the first time): the login stays in wrangler on this computer, and the token it
 * gives is renewed while setup runs. Returns { token, viaWrangler }, where token is a function giving the current token. */
export async function signIn(root) {
  if (env.CLOUDFLARE_API_TOKEN) return { token: () => env.CLOUDFLARE_API_TOKEN, viaWrangler: false };
  const read = () => {
    const { out } = runWrangler(root, ['auth', 'token', '--json']);
    try { const data = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)); return data.type === 'oauth' ? String(data.token || '') : ''; } catch { return ''; }
  };
  let token = read();
  if (!token) {
    console.log('Signing in to Cloudflare. Your browser opens Cloudflare’s own page: choose Allow.\n');
    runWrangler(root, ['login'], {}, true);
    token = read();
  }
  if (!token) stop('You are not signed in to Cloudflare.', 'Run `npm run setup` again and choose Allow on the Cloudflare page it opens.');
  let at = Date.now();
  // wrangler renews its token when asked for it; its tokens last about an hour, so a long setup asks again now and then.
  const current = () => { if (Date.now() - at > 10 * 60_000) { token = read() || token; at = Date.now(); } return token; };
  return { token: current, viaWrangler: true };
}

/** DNS records read from the domain's own Cloudflare nameservers, for a sign-in that cannot read them through the API.
 * Asking the domain's own nameservers, not a public resolver, means a record changed a moment ago is seen at once. */
export function nameserverLookup() {
  const resolvers = new Map();
  const resolverFor = zone => {
    if (!resolvers.has(zone.name)) resolvers.set(zone.name, (async () => {
      const servers = await new Resolver().resolveNs(zone.name);
      const addresses = (await Promise.all(servers.map(server => new Resolver().resolve4(server).catch(() => [])))).flat();
      const resolver = new Resolver();
      if (addresses.length) resolver.setServers(addresses);
      return resolver;
    })());
    return resolvers.get(zone.name);
  };
  return async (zone, name, type) => {
    const resolver = await resolverFor(zone);
    try {
      if (type === 'MX') return (await resolver.resolveMx(name)).map(item => ({ type, name, content: item.exchange, priority: item.priority }));
      if (type === 'TXT') return (await resolver.resolveTxt(name)).map(parts => ({ type, name, content: parts.join('') }));
      if (type === 'A') return (await resolver.resolve4(name)).map(content => ({ type, name, content }));
      if (type === 'AAAA') return (await resolver.resolve6(name)).map(content => ({ type, name, content }));
      if (type === 'CNAME') return (await resolver.resolveCname(name)).map(content => ({ type, name, content }));
      return [];
    } catch (error) { if (['ENODATA', 'ENOTFOUND', 'ENOTIMP', 'ESERVFAIL'].includes(error.code)) return []; throw error; }
  };
}
