// What `npm run setup` and `npm run recover-owner` share: prompts, the one way to stop, and finding the Cloudflare account.
import { env, exit, stdin, stdout } from 'node:process';
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

/** The Cloudflare account to use: CLOUDFLARE_ACCOUNT_ID if set, the only one the token reaches, or one picked from a list.
 * GET /accounts lists the accounts a token reaches; if it refuses, the accounts of the domains the token sees are used. */
export async function pickAccount(cf, saved) {
  let accounts = [];
  try { accounts = (await cf.page('/accounts?per_page=50')).map(item => ({ id: item.id, name: item.name })); }
  catch (error) {
    if (error instanceof CloudflareError && error.status === 0) stop('Could not reach the Cloudflare API.', 'Check the internet connection and run it again.');
    if (error instanceof CloudflareError && error.status === 401) stop('Cloudflare did not accept that token.', 'Copy the whole token again (it is shown once, right after Create Token), or make a new one with the link above.');
  }
  if (!accounts.length) {
    const zones = await listZones(cf).catch(() => []);
    accounts = [...new Map(zones.map(zone => [zone.accountId, { id: zone.accountId, name: zone.accountName }])).values()];
  }
  if (!accounts.length) stop('The token cannot see any Cloudflare account.', 'Make a new token with the link above, which picks the permissions it needs.');
  const wanted = env.CLOUDFLARE_ACCOUNT_ID || '';
  if (wanted) return accounts.find(item => item.id === wanted) || stop(`The token cannot reach the account ${wanted}.`, 'Unset CLOUDFLARE_ACCOUNT_ID, or use a token for that account.');
  if (accounts.length === 1) return accounts[0];
  accounts.sort((a, b) => a.name.localeCompare(b.name));
  console.log(accounts.map((item, index) => `  ${index + 1}. ${item.name}`).join('\n'));
  const fallback = accounts.findIndex(item => item.id === saved?.accountId) + 1;
  const picked = await ask('Which Cloudflare account (number)', fallback ? String(fallback) : '');
  return accounts[Number(picked) - 1] || stop(`"${picked || 'nothing'}" is not a number from the list.`, 'Run it again and type a number from the list.');
}
