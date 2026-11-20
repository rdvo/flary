#!/usr/bin/env node
// npm run recover-owner: for an owner who lost their password or their authenticator. It gives the owner account a one-time
// password, removes its two-step sign-in and signs it out everywhere. At the next sign-in the owner chooses a new password
// and sets up two-step again. It signs in to Cloudflare the way setup does (wrangler's sign-in, or CLOUDFLARE_API_TOKEN);
// nothing is saved.
import { pbkdf2Sync, randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudflareError, client } from '../shared/cloudflare.mjs';
import { ask, pickAccount, signIn, stop } from './cli.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(root, 'wrangler.json'), 'utf8'));
const database = config.d1_databases[0].database_name;
const saved = existsSync(join(root, 'setup.json')) ? JSON.parse(readFileSync(join(root, 'setup.json'), 'utf8')) : {};

const cf = client((await signIn(root)).token);
const accountId = (await pickAccount(cf, saved)).id;
let db;
try {
  db = ((await cf('GET', `/accounts/${accountId}/d1/database?name=${encodeURIComponent(database)}`)) || []).find(item => item.name === database);
  if (!db) stop(`There is no database named ${database} on that account.`, 'Pick the account the app runs on.');
} catch (error) {
  if (error instanceof CloudflareError && error.denied) stop('Cloudflare did not allow reading the database.', 'Run `npx wrangler login` and choose Allow, then run this again.');
  stop(`Cloudflare answered: ${error.message}`, 'Try again in a minute.');
}
/** Runs SQL with bound parameters on the live database and returns its rows. */
const sql = async (text, params = []) => (await cf('POST', `/accounts/${accountId}/d1/database/${db.uuid}/query`, { sql: text, params }))?.[0];

const owners = (await sql("SELECT m.address FROM account a JOIN mailbox m ON m.id=a.mailbox_id WHERE a.role='owner'"))?.results || [];
if (owners.length !== 1) stop(owners.length ? 'More than one owner account was found.' : 'There is no owner account.', owners.length ? 'Fix the database by hand.' : 'Open the site and create one, or run `npm run setup` for a setup link.');
const address = String(owners[0].address);

const typed = (await ask(`This resets the password and two-step sign-in of the owner, ${address}, and signs it out everywhere.\nType the owner's address to go on`)).toLowerCase();
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
