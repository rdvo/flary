#!/usr/bin/env node
// npm run setup: puts this app on your own Cloudflare account. It asks for one thing, a Cloudflare API token, then makes the
// database and the file bucket, deploys, keeps the token on the Worker as a secret, and prints one link. That link opens the
// setup wizard, where you pick your domain and name your organisation, and the app sets up mail through the Cloudflare API.
// Each step skips what already exists, so running it again is safe (it is also how you update). `-- --check` only reports.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { argv, env, exit, platform } from 'node:process';
import { fileURLToPath } from 'node:url';
import { CloudflareError, TOKEN_NEEDS, changes, client, findZone, inspect, listZones, repair, tokenLink } from '../shared/cloudflare.mjs';
import { ask, askHidden, pickAccount, stop } from './cli.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const product = JSON.parse(readFileSync(join(root, 'product.json'), 'utf8'));
const config = JSON.parse(readFileSync(join(root, 'wrangler.json'), 'utf8'));
const script = config.name, database = config.d1_databases[0].database_name, bucket = config.r2_buckets[0].bucket_name;
const ANSWERS = join(root, 'setup.json');
const saved = existsSync(ANSWERS) ? JSON.parse(readFileSync(ANSWERS, 'utf8')) : {};
const checkOnly = argv.includes('--check');

const step = text => console.log(`→ ${text}`);
const ok = text => console.log(`  ✓ ${text}`);

/** Runs wrangler with this run's token. CI=1 keeps it from prompting and from writing ids back into wrangler.json. */
const wrangler = (args, accountId, token) => {
  const result = spawnSync('npx', ['--no-install', 'wrangler', ...args], { cwd: root, encoding: 'utf8', shell: platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
  return { ok: result.status === 0, out: `${result.stdout || ''}${result.stderr || ''}` };
};
const tail = out => out.trim().split('\n').slice(-12).map(line => `    ${line}`).join('\n');
const denied = (what, needs) => stop(`The Cloudflare token is not allowed to ${what}.`, `Add ${needs} to the token (or make a new one with the link above) and run setup again.`);

// 0. Ready to run?
if (!existsSync(join(root, 'node_modules', 'wrangler'))) stop('The project’s packages are not installed.', 'Run `npm install` in this folder, then `npm run setup` again.');

// 1. The token: the only question. It goes to Cloudflare and onto the Worker as a secret, never into a file here.
console.log(`\n${product.name} setup${checkOnly ? ' (check only: nothing is changed)' : ''}\n`);
let token = env.CLOUDFLARE_API_TOKEN || '';
if (!token) {
  console.log(`It needs a Cloudflare API token. Make one here, with the permissions already picked:\n\n  ${tokenLink(product.name)}\n`);
  console.log(`On that page, check the token has all of these (add any that are missing), then Continue to summary > Create Token:\n${TOKEN_NEEDS.map(line => `  ${line}`).join('\n')}\n`);
  token = await askHidden('Paste the token (it is not shown)');
}
if (!token) stop('No token was given.', 'Run `npm run setup` again and paste the token when it asks.');
const cf = client(token);

// 2. The account, and a domain the wizard can use.
step('Checking the token');
const account = await pickAccount(cf, saved), accountId = account.id;
let zones = [];
try { zones = (await listZones(cf)).filter(zone => zone.accountId === accountId); } catch (error) {
  if (error instanceof CloudflareError && error.denied) denied('list your domains', 'Zone Read on all zones');
  stop(`Cloudflare answered: ${error.message}`, 'Run setup again in a minute.');
}
if (!zones.length) stop(`The token cannot see an active domain in ${account.name}.`, 'Add your domain to Cloudflare and wait until it shows as Active (its nameservers must point to Cloudflare), and make the token with the link above so it has Zone Read on all zones.');
ok(`${account.name}: ${zones.map(zone => zone.name).join(', ')}`);
if (!checkOnly) writeFileSync(ANSWERS, `${JSON.stringify({ accountId }, null, 2)}\n`);

const findDatabase = async () => ((await cf('GET', `/accounts/${accountId}/d1/database?name=${encodeURIComponent(database)}`)) || []).find(item => item.name === database) || null;
const query = async (id, sql) => (await cf('POST', `/accounts/${accountId}/d1/database/${id}/query`, { sql }))?.[0]?.results || [];
/** Whether the owner account exists. No tables yet means no owner. */
const ownerExists = async id => {
  try { return Number((await query(id, 'SELECT COUNT(*) AS n FROM account'))[0]?.n || 0) > 0; }
  catch (error) { if (/no such table/i.test(error.message)) return false; throw error; }
};
/** What the wizard saved: the domain and the web address. */
const settingsOf = async id => {
  try { return Object.fromEntries((await query(id, "SELECT key,value FROM setting WHERE key IN ('domain','host')")).map(row => [row.key, row.value])); }
  catch (error) { if (/no such table/i.test(error.message)) return {}; throw error; }
};
const workersDev = async () => { try { return (await cf('GET', `/accounts/${accountId}/workers/subdomain`))?.subdomain || ''; } catch (error) { if (error instanceof CloudflareError && error.denied) throw error; return ''; } };
/** The mail, sending and web-address steps for an install whose wizard has run. */
const contextOf = async settings => {
  const zone = settings.domain ? await findZone(cf, settings.domain) : null;
  return zone ? { product: product.name, domain: settings.domain, host: settings.host || '', script, accountId, zone } : null;
};

// --check: say where things stand, change nothing.
if (checkOnly) {
  const lines = [];
  const line = (good, label, fix = '') => lines.push(`  ${good ? '✓' : '✗'} ${label}${!good && fix ? `\n      To fix: ${fix}` : ''}`);
  try {
    const db = await findDatabase();
    line(Boolean(db), `Database ${database}`, 'Run `npm run setup`.');
    let bucketThere = false;
    try { await cf('GET', `/accounts/${accountId}/r2/buckets/${bucket}`); bucketThere = true; } catch (error) { if (error instanceof CloudflareError && error.denied) throw error; }
    line(bucketThere, `File bucket ${bucket}`, 'Run `npm run setup`.');
    let deployed = false;
    try { await cf('GET', `/accounts/${accountId}/workers/scripts/${script}/settings`); deployed = true; } catch (error) { if (error instanceof CloudflareError && error.denied) throw error; }
    line(deployed, `Worker ${script} is deployed`, 'Run `npm run setup`.');
    const owner = db ? await ownerExists(db.uuid) : false;
    line(owner, 'The setup wizard has been finished', 'Run `npm run setup` for a fresh link to the wizard.');
    const c = db && owner ? await contextOf(await settingsOf(db.uuid)) : null;
    if (c) for (const item of await inspect(cf, c)) line(item.ok, `${item.label}${item.detail ? ` (${item.detail})` : ''}`, item.fix);
  } catch (error) {
    if (error instanceof CloudflareError && error.denied) stop('The token is not allowed to read everything setup checks.', `Make sure the token has: ${TOKEN_NEEDS.join('; ')}.`);
    stop(`Cloudflare answered: ${error.message}`, 'Run the check again in a minute.');
  }
  console.log(`\n${lines.join('\n')}\n`);
  exit(lines.some(text => text.startsWith('  ✗')) ? 1 : 0);
}

// 3. A workers.dev name for the account: deploying needs one, and wrangler can't make one without asking.
step('Checking the account has a workers.dev address');
let subdomain = '';
try { subdomain = await workersDev(); } catch { denied('read Workers settings', 'Workers Scripts Edit'); }
if (!subdomain) stop('This Cloudflare account has never opened Workers, so it has no workers.dev address yet.', `Open https://dash.cloudflare.com/${accountId}/workers/onboarding once and pick a name, then run setup again.`);
ok(`${subdomain}.workers.dev`);

// 4. Database and bucket, each made only if missing. The app makes its own tables on its first request.
step(`Making the database ${database}`);
let db;
try {
  db = await findDatabase();
  if (db) ok('Already there');
  else { db = await cf('POST', `/accounts/${accountId}/d1/database`, { name: database }); ok('Made'); }
} catch (error) {
  if (error instanceof CloudflareError && error.denied) denied('make a D1 database', 'Account D1 Edit');
  stop(`Could not make the database: ${error.message}`, 'Run setup again in a minute.');
}

step(`Making the file bucket ${bucket}`);
try {
  try { await cf('GET', `/accounts/${accountId}/r2/buckets/${bucket}`); ok('Already there'); }
  catch (error) {
    if (!(error instanceof CloudflareError) || error.denied || error.status !== 404) throw error;
    await cf('POST', `/accounts/${accountId}/r2/buckets`, { name: bucket }); ok('Made');
  }
} catch (error) {
  if (/enable R2|R2 (is )?not enabled|10042/i.test(error.message)) stop('R2 is not turned on for this Cloudflare account.', `Open https://dash.cloudflare.com/${accountId}/r2/overview and turn on R2 (its free tier covers a small org), then run setup again.`);
  if (error instanceof CloudflareError && error.denied) denied('make an R2 bucket', 'Account Workers R2 Storage Edit');
  stop(`Could not make the file bucket: ${error.message}`, 'Run setup again in a minute.');
}

// 5. Build and deploy.
step('Building and uploading the app (about a minute)');
const deployed = wrangler(['deploy'], accountId, token);
if (!deployed.ok) {
  const out = deployed.out;
  if (/workers\.dev subdomain/i.test(out)) stop('This Cloudflare account has no workers.dev address yet.', `Open https://dash.cloudflare.com/${accountId}/workers/onboarding once and pick a name, then run setup again.`);
  if (/Authentication|10000|not authorized/i.test(out)) denied('deploy a Worker', 'Account Workers Scripts Edit');
  if (/vite|build/i.test(out) && !/Uploaded|Deployed/i.test(out)) stop(`The app did not build. The build said:\n${tail(out)}`, 'Run `npm install` again, then `npm run setup`.');
  stop(`The deploy did not finish. Wrangler said:\n${tail(out)}`, 'Run setup again; it carries on from here.');
}
const live = `https://${script}.${subdomain}.workers.dev`;
ok(`Live at ${live}`);

// 6. The token goes onto the Worker, so the wizard and Setup health never ask for it. If the wizard has not been finished,
// a fresh one-time setup code goes on too, and into the link printed below.
// PUT /accounts/{a}/workers/scripts/{name}/secrets needs Workers Scripts Edit; each replaces the value from any earlier run.
step('Keeping the token on the app');
let code = '', owner = false;
try {
  await cf('PUT', `/accounts/${accountId}/workers/scripts/${script}/secrets`, { name: 'CF_API_TOKEN', text: token, type: 'secret_text' });
  owner = await ownerExists(db.uuid);
  if (!owner) {
    code = randomBytes(18).toString('base64url');
    await cf('PUT', `/accounts/${accountId}/workers/scripts/${script}/secrets`, { name: 'SETUP_TOKEN', text: code, type: 'secret_text' });
  }
  ok('Done');
} catch (error) {
  if (error instanceof CloudflareError && error.denied) denied('set a Worker secret', 'Account Workers Scripts Edit');
  stop(`Could not store the token: ${error.message}`, 'Run setup again in a minute.');
}

if (code) {
  console.log(`\nDone. Open this link to finish in your browser (it works once):\n\n  ${live}/#setup=${code}\n`);
  console.log('There you name your organisation, pick your domain and make your account; the app sets up the mail.\n');
  exit(0);
}

// 7. Already set up: an update. Mail in, mail out and the web address are checked and put right, as Setup health does.
const c = await contextOf(await settingsOf(db.uuid)).catch(() => null);
if (!c) { console.log(`\nDone. Open ${live}\n`); exit(0); }
step(`Checking where mail for ${c.domain} goes`);
let confirmed = '';
try {
  const plan = await changes(cf, c);
  if (plan.confirm.length) {
    console.log(`\n  Stop and read this. Setup would change these for ${c.domain}:\n${plan.confirm.map(text => `   - ${text}`).join('\n')}\n`);
    confirmed = (await ask(`Type ${c.domain} to go on, or press Enter to leave things as they are`)).toLowerCase();
  } else ok(plan.state.catchAllOurs ? 'Mail comes here' : 'Nothing to move');
} catch (error) {
  if (error instanceof CloudflareError && error.denied) denied(`read ${c.domain}’s DNS and Email Routing`, 'DNS Edit, Zone Settings Edit and Email Routing Rules Edit');
  stop(`Could not read where mail for ${c.domain} goes: ${error.message}`, 'Run setup again in a minute.');
}
const result = await repair(cf, c, { confirmed, say: step });
if (result.confirm) stop('Nothing was changed.', `Run setup again and type ${c.domain} when you want its mail to come here.`);
if (result.failed) stop(result.failed.problem, result.failed.fix);
console.log(`\nDone. Open https://${c.host || `${script}.${subdomain}.workers.dev`}\n`);
