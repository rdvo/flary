#!/usr/bin/env node
// npm run recover-owner: for an owner who lost their password or their authenticator. It gives the owner account a one-time
// password, removes its two-step sign-in and signs it out everywhere. At the next sign-in the owner chooses a new password
// and sets up two-step again. It asks for a Cloudflare API token for the account the app runs on (the same kind setup uses);
// the token is used by this run and never saved.
import { pbkdf2Sync, randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { env, exit, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { CloudflareError, client, findZone } from '../shared/cloudflare.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(root, 'wrangler.json'), 'utf8'));
const database = config.d1_databases[0].database_name;
const saved = existsSync(join(root, 'setup.json')) ? JSON.parse(readFileSync(join(root, 'setup.json'), 'utf8')) : {};
const stop = (problem, fix) => { console.error(`\n✗ ${problem}\n  To fix: ${fix}\n`); exit(1); };
const ask = async question => { const rl = createInterface({ input: stdin, output: stdout }); try { return (await rl.question(question)).trim(); } finally { rl.close(); } };
const askHidden = async question => {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  stdout.write(question); rl._writeToOutput = () => {};
  try { return (await rl.question('')).trim(); } finally { rl.close(); stdout.write('\n'); }
};

const token = env.CLOUDFLARE_API_TOKEN || await askHidden('Cloudflare API token (not shown or saved): ');
const domain = (env.DOMAIN || saved.domain || await ask('Your mail domain: ')).toLowerCase();
const cf = client(token);
let accountId, db;
try {
  const zone = await findZone(cf, domain);
  if (!zone) stop(`The token cannot see ${domain} as an active domain.`, 'Use a token with Zone Read for that domain (the setup token works).');
  accountId = zone.accountId;
  db = ((await cf('GET', `/accounts/${accountId}/d1/database?name=${encodeURIComponent(database)}`)) || []).find(item => item.name === database);
  if (!db) stop(`There is no database named ${database} on that account.`, 'Run this with a token for the account the app runs on.');
} catch (error) {
  if (error instanceof CloudflareError && error.denied) stop('Cloudflare did not accept that token, or it lacks D1 access.', 'Use a token with Account D1 Edit and Zone Read (the setup token works).');
  stop(`Cloudflare answered: ${error.message}`, 'Try again in a minute.');
}
/** Runs SQL with bound parameters on the live database and returns its rows. */
const sql = async (text, params = []) => (await cf('POST', `/accounts/${accountId}/d1/database/${db.uuid}/query`, { sql: text, params }))?.[0];

const owners = (await sql("SELECT m.address FROM account a JOIN mailbox m ON m.id=a.mailbox_id WHERE a.role='owner'"))?.results || [];
if (owners.length !== 1) stop(owners.length ? 'More than one owner account was found.' : 'There is no owner account.', owners.length ? 'Fix the database by hand.' : 'Open the site and create one, or run `npm run setup` for a setup link.');
const address = String(owners[0].address);

const typed = (await ask(`This resets the password and two-step sign-in of the owner, ${address}, and signs it out everywhere.\nType the owner's address to go on: `)).toLowerCase();
if (typed !== address) stop('Stopped. Nothing was changed.', `Run it again and type ${address} exactly.`);

// The same one-time password shape and the same PBKDF2 hash the Worker uses (worker/auth.ts).
const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const password = Array.from({ length: 14 }, () => LETTERS[randomInt(LETTERS.length)]).join('');
const salt = randomBytes(16).toString('hex'), hash = `${salt}:${pbkdf2Sync(password, salt, 100_000, 32, 'sha256').toString('hex')}`;

const updated = await sql("UPDATE account SET password=?1,must_change=1,totp=NULL,totp_pending=NULL,totp_step=0,failed=0,locked_until=0 WHERE role='owner'", [hash]);
if (!((updated?.meta?.changes ?? 0) >= 1)) stop('The owner account was not changed.', 'Nothing else was done. Try again.');
await sql("DELETE FROM session WHERE account_id IN (SELECT id FROM account WHERE role='owner')");

console.log(`
Done. Sign in as ${address} with this one-time password:

    ${password}

You will choose a new password, then set up two-step sign-in with your authenticator app again.`);
