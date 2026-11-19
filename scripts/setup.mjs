#!/usr/bin/env node
// npm run setup: puts this app on your own Cloudflare account with one API token. It asks for the token and the domain,
// then makes the database, the file bucket and the tables, deploys, turns on Email Routing with the catch-all pointed at
// the Worker, sets the domain up to send, and prints one link. Each step says what it does and skips what already exists,
// so running it again is safe. `npm run setup -- --check` only reports. The token is used by this run and never saved.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { argv, env, exit, platform, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { CloudflareError, TOKEN_NEEDS, client, findZone, inspect, listZones, mailState, repair, tokenLink } from '../shared/cloudflare.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const product = JSON.parse(readFileSync(join(root, 'product.json'), 'utf8'));
const config = JSON.parse(readFileSync(join(root, 'wrangler.json'), 'utf8'));
const script = config.name, database = config.d1_databases[0].database_name, bucket = config.r2_buckets[0].bucket_name;
const ANSWERS = join(root, 'setup.json');
const saved = existsSync(ANSWERS) ? JSON.parse(readFileSync(ANSWERS, 'utf8')) : {};
const checkOnly = argv.includes('--check');
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const step = text => console.log(`→ ${text}`);
const ok = text => console.log(`  ✓ ${text}`);
/** The one way this script stops: what went wrong, and the one thing to do about it. */
const stop = (problem, fix) => { console.error(`\n✗ ${problem}\n  To fix: ${fix}\n`); exit(1); };

// A fresh prompt each time, closed after, so commands run in between get the terminal to themselves.
const ask = async (question, fallback = '') => {
  const rl = createInterface({ input: stdin, output: stdout });
  try { return (await rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback; } finally { rl.close(); }
};
/** Asks without echoing what is typed or pasted. */
const askHidden = async question => {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  stdout.write(`${question}: `);
  rl._writeToOutput = () => {};
  try { return (await rl.question('')).trim(); } finally { rl.close(); stdout.write('\n'); }
};

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

// 1. The token. Never written anywhere; CLOUDFLARE_API_TOKEN works too, for people who keep one in their shell.
console.log(`\n${product.name} setup${checkOnly ? ' (check only: nothing is changed)' : ''}\n`);
let token = env.CLOUDFLARE_API_TOKEN || '';
if (!token) {
  console.log(`It needs a Cloudflare API token. Make one here, with the permissions already picked:\n\n  ${tokenLink(`${product.name} setup`)}\n`);
  console.log(`On that page, check the token has all of these (add any that are missing), then Continue to summary > Create Token:\n${TOKEN_NEEDS.map(line => `  ${line}`).join('\n')}\n`);
  token = await askHidden('Paste the token (it is not shown or saved)');
}
if (!token) stop('No token was given.', 'Run `npm run setup` again and paste the token when it asks.');
const cf = client(token);

// 2. The domain, picked from the ones the token can see.
step('Finding the domains this token can set up');
let zones;
try { zones = await listZones(cf); } catch (error) {
  if (error instanceof CloudflareError && error.status === 0) stop('Could not reach the Cloudflare API.', 'Check the internet connection and run setup again.');
  if (error instanceof CloudflareError && error.denied) stop('Cloudflare did not accept that token.', 'Copy the whole token again (it is shown once, right after Create Token), or make a new one with the link above.');
  stop(`Cloudflare answered: ${error.message}`, 'Run setup again in a minute.');
}
if (!zones.length) stop('The token cannot see any active domain.', 'Give the token Zone Read on "All zones", and make sure the domain shows as Active in the Cloudflare dashboard.');
let domain = (env.DOMAIN || '').toLowerCase();
if (!domain) {
  zones.sort((a, b) => a.name.localeCompare(b.name));
  console.log(zones.map((zone, index) => `  ${index + 1}. ${zone.name}`).join('\n'));
  const fallback = saved.domain && zones.some(zone => zone.name === saved.domain) ? saved.domain : zones.length === 1 ? zones[0].name : '';
  const picked = (await ask('Your domain (number or name)', fallback)).toLowerCase();
  domain = /^\d+$/.test(picked) ? zones[Number(picked) - 1]?.name || '' : picked;
}
if (!DOMAIN_RE.test(domain)) stop(`"${domain || 'nothing'}" is not one of the domains listed.`, 'Run setup again and type a number from the list.');
const zone = zones.find(item => item.name === domain) || await findZone(cf, domain).catch(() => null);
if (!zone) stop(`${domain} is not an active domain on the token’s account.`, `Add ${domain} to Cloudflare and wait until it shows as Active (its nameservers must point to Cloudflare), or give the token access to it.`);
const accountId = zone.accountId;

// 3. The web address.
let host = (env.HOST || '').toLowerCase();
if (!host) host = (await ask(`Web address for ${product.name}`, saved.host && (saved.host === domain || saved.host.endsWith(`.${domain}`)) ? saved.host : `mail.${domain}`)).toLowerCase();
host = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
if (!(host === domain || host.endsWith(`.${domain}`)) || !DOMAIN_RE.test(host)) stop(`${host} is not on ${domain}.`, `Run setup again and use ${domain} or a name under it, like mail.${domain}.`);
if (!checkOnly) writeFileSync(ANSWERS, `${JSON.stringify({ domain, host }, null, 2)}\n`);
const c = { product: product.name, domain, host, script, accountId, zone };

const findDatabase = async () => ((await cf('GET', `/accounts/${accountId}/d1/database?name=${encodeURIComponent(database)}`)) || []).find(item => item.name === database) || null;
const query = async (id, sql) => (await cf('POST', `/accounts/${accountId}/d1/database/${id}/query`, { sql }))?.[0]?.results || [];
/** Whether the owner account exists. No tables yet means no owner. */
const ownerExists = async id => {
  try { return Number((await query(id, 'SELECT COUNT(*) AS n FROM account'))[0]?.n || 0) > 0; }
  catch (error) { if (/no such table/i.test(error.message)) return false; throw error; }
};
const workersDev = async () => { try { return (await cf('GET', `/accounts/${accountId}/workers/subdomain`))?.subdomain || ''; } catch (error) { if (error instanceof CloudflareError && error.denied) throw error; return ''; } };

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
    line(owner, 'Owner account', `Open https://${host} and create it, or run \`npm run setup\` for a fresh setup link.`);
    for (const item of await inspect(cf, c)) line(item.ok, `${item.label}${item.detail ? ` (${item.detail})` : ''}`, item.fix);
  } catch (error) {
    if (error instanceof CloudflareError && error.denied) stop('The token is not allowed to read everything setup checks.', `Make sure the token has: ${TOKEN_NEEDS.join('; ')}.`);
    stop(`Cloudflare answered: ${error.message}`, 'Run the check again in a minute.');
  }
  console.log(`\n${lines.join('\n')}\n`);
  exit(lines.some(text => text.startsWith('  ✗')) ? 1 : 0);
}

// 4. Before anything is made: if the domain's mail goes somewhere today, say so and ask for the domain, typed.
step(`Checking where mail for ${domain} goes now`);
let confirmed = '';
try {
  const mail = await mailState(cf, zone, script);
  if (!mail.catchAllOurs && mail.elsewhere.length) {
    console.log(`\n  Stop and read this. Setup would send ALL mail for ${domain} to ${product.name}:\n${mail.elsewhere.map(text => `   - ${text}`).join('\n')}`);
    console.log(`  After this, that mail arrives in ${product.name} instead, and the old place gets nothing new.\n`);
    confirmed = (await ask(`Type ${domain} to go on, or press Enter to stop`)).toLowerCase();
    if (confirmed !== domain) stop('Stopped before changing anything.', `Nothing was changed. Run setup again and type ${domain} when you are ready for its mail to come to ${product.name}.`);
  } else ok(mail.catchAllOurs ? `Mail already comes to ${product.name}` : 'Nothing to move');
} catch (error) {
  if (error instanceof CloudflareError && error.denied) denied(`read ${domain}’s DNS and Email Routing`, 'DNS Edit, Zone Settings Edit and Email Routing Rules Edit');
  stop(`Could not read where mail for ${domain} goes: ${error.message}`, 'Run setup again in a minute.');
}

// 5. A workers.dev name for the account: deploying needs one, and wrangler can't make one without asking.
step('Checking the account has a workers.dev address');
let subdomain = '';
try { subdomain = await workersDev(); } catch { denied('read Workers settings', 'Workers Scripts Edit'); }
if (!subdomain) stop('This Cloudflare account has never opened Workers, so it has no workers.dev address yet.', `Open https://dash.cloudflare.com/${accountId}/workers/onboarding once and pick a name, then run setup again.`);
ok(`${subdomain}.workers.dev`);

// 6. Database, bucket and tables. Each is made only if missing.
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

step('Making the tables');
const migrated = wrangler(['d1', 'migrations', 'apply', database, '--remote'], accountId, token);
if (!migrated.ok) stop(`The tables were not made. Wrangler said:\n${tail(migrated.out)}`, /Authentication|10000|not authorized/i.test(migrated.out) ? 'Add Account D1 Edit to the token and run setup again.' : 'Run setup again; it carries on from here.');
ok('Up to date');

// 7. Build and deploy. DOMAIN goes in as a variable; `npm run deploy` keeps it (--keep-vars).
step('Building and uploading the app (about a minute)');
const deployed = wrangler(['deploy', '--var', `DOMAIN:${domain}`], accountId, token);
if (!deployed.ok) {
  const out = deployed.out;
  if (/workers\.dev subdomain/i.test(out)) stop('This Cloudflare account has no workers.dev address yet.', `Open https://dash.cloudflare.com/${accountId}/workers/onboarding once and pick a name, then run setup again.`);
  if (/Authentication|10000|not authorized/i.test(out)) denied('deploy a Worker', 'Account Workers Scripts Edit');
  if (/vite|build/i.test(out) && !/Uploaded|Deployed/i.test(out)) stop(`The app did not build. The build said:\n${tail(out)}`, 'Run `npm install` again, then `npm run setup`.');
  stop(`The deploy did not finish. Wrangler said:\n${tail(out)}`, 'Run setup again; it carries on from here.');
}
ok(`Live at https://${script}.${subdomain}.workers.dev`);

// 8. The owner account. If none exists, a fresh one-time setup code goes in as a secret and into the link printed below.
step('Checking for the owner account');
let code = '';
try {
  if (await ownerExists(db.uuid)) ok('Already made');
  else {
    code = randomBytes(18).toString('base64url');
    // PUT /accounts/{a}/workers/scripts/{name}/secrets needs Workers Scripts Edit. It replaces the code from any earlier run.
    await cf('PUT', `/accounts/${accountId}/workers/scripts/${script}/secrets`, { name: 'SETUP_TOKEN', text: code, type: 'secret_text' });
    ok('Not yet: the link below makes it');
  }
} catch (error) {
  if (error instanceof CloudflareError && error.denied) denied('set a Worker secret', 'Account Workers Scripts Edit');
  stop(`Could not check for the owner account: ${error.message}`, 'Run setup again in a minute.');
}

// 9. Mail in, mail out and the web address: the same steps, in the same order, as the app's Setup health panel.
const result = await repair(cf, c, { confirmed, say: step });
if (result.confirm) stop('Mail for the domain started going somewhere else while setup ran.', 'Run setup again and read the list it shows.');
if (result.failed) stop(result.failed.problem, result.failed.fix);

const base = `https://${host}`;
console.log(`\nDone. ${code ? `Open this link to make the owner account (it works once):\n\n  ${base}/#setup=${code}` : `Open ${product.name}:\n\n  ${base}`}\n`);
console.log(`A new web address can take a few minutes to get its certificate. Until then, ${code ? `the same link works at https://${script}.${subdomain}.workers.dev/#setup=${code}` : `use https://${script}.${subdomain}.workers.dev`}.`);
console.log('Sending to addresses outside your own verified ones needs the Workers Paid plan. Check any time with `npm run setup -- --check`.\n');
