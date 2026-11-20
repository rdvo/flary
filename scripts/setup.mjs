#!/usr/bin/env node
// npm run setup: puts this app on your own Cloudflare account. It signs in to Cloudflare with wrangler (Cloudflare's own
// consent page in your browser, the first time), makes the database and the file bucket, deploys, and prints one link to the
// setup wizard. It waits while you finish the wizard, then sets up mail in, mail out and the web address from this computer.
// No Cloudflare token is ever saved by it or kept on the app. Running it again is safe and is also how you update or fix
// things. `-- --check` only reports. `-- --move-mail=<domain>` answers "yes, take over this domain's mail" without a prompt.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { argv, env, exit, stdin } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CloudflareError, changes, client, findZone, inspect, listZones, repair, tokenLink } from '../shared/cloudflare.mjs';
import { ask, askHidden, nameserverLookup, pickAccount, runWrangler, signIn, stop } from './cli.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const product = JSON.parse(readFileSync(join(root, 'product.json'), 'utf8'));
const config = JSON.parse(readFileSync(join(root, 'wrangler.json'), 'utf8'));
const script = config.name, database = config.d1_databases[0].database_name, bucket = config.r2_buckets[0].bucket_name;
const ANSWERS = join(root, 'setup.json');
const saved = existsSync(ANSWERS) ? JSON.parse(readFileSync(ANSWERS, 'utf8')) : {};
const checkOnly = argv.includes('--check');
const moveMail = (argv.find(arg => arg.startsWith('--move-mail=')) || '').split('=')[1]?.toLowerCase() || '';
const interactive = Boolean(stdin.isTTY);

const step = text => console.log(`→ ${text}`);
const ok = text => console.log(`  ✓ ${text}`);
const tail = out => out.trim().split('\n').slice(-12).map(line => `    ${line}`).join('\n');
const denied = what => stop(`Cloudflare did not allow setup to ${what}.`, 'Run `npx wrangler login` and choose Allow, then run `npm run setup` again.');

// 0. Ready to run?
if (!existsSync(join(root, 'node_modules', 'wrangler'))) stop('The project’s packages are not installed.', 'Run `npm install` in this folder, then `npm run setup` again.');

// 1. Sign in to Cloudflare, and pick the account.
console.log(`\n${product.name} setup${checkOnly ? ' (check only: nothing is changed)' : ''}\n`);
const auth = await signIn(root);
const cf = client(auth.token);
cf.lookup = nameserverLookup();
step('Checking your Cloudflare account');
const account = await pickAccount(cf, saved), accountId = account.id;
let zones = [];
try { zones = (await listZones(cf)).filter(zone => zone.accountId === accountId); } catch (error) {
  if (error instanceof CloudflareError && error.denied) denied('list your domains');
  stop(`Cloudflare answered: ${error.message}`, 'Run setup again in a minute.');
}
if (!zones.length) stop(`There is no active domain in ${account.name}.`, 'Add your domain to Cloudflare and wait until it shows as Active (its nameservers must point to Cloudflare), then run setup again.');
ok(`${account.name}: ${zones.map(zone => zone.name).join(', ')}`);
if (!checkOnly) writeFileSync(ANSWERS, `${JSON.stringify({ accountId }, null, 2)}\n`);

/** Wrangler for this account, signed in the same way as this run. */
const wrangler = args => runWrangler(root, args, { CLOUDFLARE_ACCOUNT_ID: accountId, CI: '1', ...(auth.viaWrangler ? {} : { CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN }) });
const findDatabase = async () => ((await cf('GET', `/accounts/${accountId}/d1/database?name=${encodeURIComponent(database)}`)) || []).find(item => item.name === database) || null;
const query = async (id, sql, params = []) => (await cf('POST', `/accounts/${accountId}/d1/database/${id}/query`, { sql, params }))?.[0]?.results || [];
const missingTable = error => /no such table/i.test(error.message);
/** Whether the owner account exists. No tables yet means no owner. */
const ownerExists = async id => {
  try { return Number((await query(id, 'SELECT COUNT(*) AS n FROM account'))[0]?.n || 0) > 0; }
  catch (error) { if (missingTable(error)) return false; throw error; }
};
const settingsOf = async id => {
  try { return Object.fromEntries((await query(id, 'SELECT key,value FROM setting')).map(row => [row.key, row.value])); }
  catch (error) { if (missingTable(error)) return {}; throw error; }
};
const saveSetting = (id, key, value) => query(id, 'INSERT OR REPLACE INTO setting(key,value) VALUES(?1,?2)', [key, value]);
const workersDev = async () => { try { return (await cf('GET', `/accounts/${accountId}/workers/subdomain`))?.subdomain || ''; } catch (error) { if (error instanceof CloudflareError && error.denied) throw error; return ''; } };
/** What the mail, sending and web-address steps need, from the wizard's answers. */
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
    if (error instanceof CloudflareError && error.denied) denied('read everything it checks');
    stop(`Cloudflare answered: ${error.message}`, 'Run the check again in a minute.');
  }
  console.log(`\n${lines.join('\n')}\n`);
  exit(lines.some(text => text.startsWith('  ✗')) ? 1 : 0);
}

// 2. A workers.dev name for the account: deploying needs one, and wrangler can't make one without asking.
step('Checking the account has a workers.dev address');
let subdomain = '';
try { subdomain = await workersDev(); } catch { denied('read Workers settings'); }
if (!subdomain) stop('This Cloudflare account has never opened Workers, so it has no workers.dev address yet.', `Open https://dash.cloudflare.com/${accountId}/workers/onboarding once and pick a name, then run setup again.`);
ok(`${subdomain}.workers.dev`);

// 3. Database and bucket, each made only if missing. The app makes the rest of its tables on its first request.
step(`Making the database ${database}`);
let db;
try {
  db = await findDatabase();
  if (db) ok('Already there');
  else { db = await cf('POST', `/accounts/${accountId}/d1/database`, { name: database }); ok('Made'); }
  // The same table migrations/0002_setup.sql makes, so the installer can leave the wizard its list of domains.
  await query(db.uuid, 'CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
} catch (error) {
  if (error instanceof CloudflareError && error.denied) denied('make a D1 database');
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
  if (error instanceof CloudflareError && error.denied) denied('make an R2 bucket');
  stop(`Could not make the file bucket: ${error.message}`, 'Run setup again in a minute.');
}

// 4. Build and deploy.
step('Building and uploading the app (about a minute)');
const deployed = wrangler(['deploy']);
if (!deployed.ok) {
  const out = deployed.out;
  if (/workers\.dev subdomain/i.test(out)) stop('This Cloudflare account has no workers.dev address yet.', `Open https://dash.cloudflare.com/${accountId}/workers/onboarding once and pick a name, then run setup again.`);
  if (/Authentication|10000|not authorized/i.test(out)) denied('deploy a Worker');
  if (/vite|build/i.test(out) && !/Uploaded|Deployed/i.test(out)) stop(`The app did not build. The build said:\n${tail(out)}`, 'Run `npm install` again, then `npm run setup`.');
  stop(`The deploy did not finish. Wrangler said:\n${tail(out)}`, 'Run setup again; it carries on from here.');
}
const live = `https://${script}.${subdomain}.workers.dev`;
ok(`Live at ${live}`);

// 5. A first run: the wizard. A one-time setup code goes on as a secret and into the link, the domains go in for the wizard
// to offer (with what taking over each one's mail would change), and setup waits until the wizard is finished.
let settings;
try {
  if (!await ownerExists(db.uuid)) {
    step('Getting the setup wizard ready');
    const code = randomBytes(18).toString('base64url');
    // PUT …/scripts/{name}/secrets needs Workers Scripts Edit; it replaces the code from any earlier run.
    await cf('PUT', `/accounts/${accountId}/workers/scripts/${script}/secrets`, { name: 'SETUP_TOKEN', text: code, type: 'secret_text' });
    // Every domain, a few at a time: the wizard needs to know which ones already get mail somewhere else.
    const domains = [];
    for (let at = 0; at < zones.length; at += 6) {
      domains.push(...await Promise.all(zones.slice(at, at + 6).map(async zone => ({ name: zone.name,
        moves: (await changes(cf, { product: product.name, domain: zone.name, host: '', script, accountId, zone }).catch(() => ({ confirm: [] }))).confirm }))));
    }
    await saveSetting(db.uuid, 'domains', JSON.stringify(domains));
    ok('Ready');
    console.log(`\nOpen this link to finish in your browser (it works once):\n\n  ${live}/#setup=${code}\n`);
    console.log('There you name your organisation, pick your domain and make your account.');
    console.log('Keep this running: when the wizard is done, setup carries on here and sets up your mail.\n');
    step('Waiting for the wizard');
    for (;;) {
      await sleep(4000);
      if (await ownerExists(db.uuid)) break;
    }
    ok('The wizard is done');
  }
  settings = await settingsOf(db.uuid);
} catch (error) {
  if (error instanceof CloudflareError && error.denied) denied('set up the wizard');
  stop(`Could not get the wizard ready: ${error.message}`, 'Run setup again in a minute.');
}

// 6. Mail in, mail out and the web address: the same steps, in the same order, as Setup health.
const c = await contextOf(settings).catch(() => null);
if (!c) { console.log(`\nDone. Open ${live}\n`); exit(0); }
let confirmed = settings.confirmed || moveMail;
let dns = cf;
let result;
for (let tries = 0; ; tries++) {
  result = await repair(cf, c, { confirmed, say: step, dns });
  if (result.confirm) {
    console.log(`\n  Stop and read this. Setup would change these for ${c.domain}:\n${result.confirm.map(text => `   - ${text}`).join('\n')}\n`);
    if (!interactive) stop('Nothing was changed.', `If you want all mail for ${c.domain} to come to ${product.name}, run \`npm run setup -- --move-mail=${c.domain}\`.`);
    confirmed = (await ask(`Type ${c.domain} to go on, or press Enter to leave things as they are`)).toLowerCase();
    if (confirmed !== c.domain) stop('Nothing was changed.', `Run setup again and type ${c.domain} when you want its mail to come here.`);
    continue;
  }
  if (!result.failed?.records || tries > 90) break;
  // wrangler's sign-in can't edit DNS records: list the changes, and carry on once they are made.
  console.log(`\n  ${result.failed.problem}\n${result.failed.records.map(line => `   - ${line}`).join('\n')}\n\n  Make them here: https://dash.cloudflare.com/${accountId}/${c.domain}/dns/records\n`);
  if (interactive) {
    console.log(`  Or paste a Cloudflare API token with Zone DNS Edit (make one at ${tokenLink(`${product.name} DNS`)}) and setup makes them; it is used once and not saved.`);
    const pasted = await askHidden('Press Enter once they are made, or paste a token');
    if (pasted) { dns = client(pasted); dns.lookup = cf.lookup; }
  } else {
    console.log('  Waiting for those changes (checking every 20 seconds)…');
    await sleep(20_000);
  }
}

// Whatever happened is kept for the app's Setup health panel.
await saveSetting(db.uuid, 'setup_report', JSON.stringify({ at: Date.now(), done: result.done, ...(result.failed ? { failed: result.failed } : {}) })).catch(() => null);
if (result.confirm) stop('Nothing was changed.', `Run setup again and type ${c.domain} when you want its mail to come here.`);
if (result.failed) stop(result.failed.records ? `${result.failed.problem}\n${result.failed.records.map(line => `   - ${line}`).join('\n')}` : result.failed.problem, result.failed.fix);
console.log(`\nDone. ${product.name} is at https://${c.host || `${script}.${subdomain}.workers.dev`}`);
if (c.host) console.log(`A new web address can take a few minutes to get its certificate. Until then, use ${live}.`);
console.log(`Sending to addresses outside your own verified ones needs the Workers Paid plan. Check any time with \`npm run setup -- --check\`.\n`);
