import type { Account } from './auth';
import { PRODUCT, cleanName, json, readJson, type Env } from './util';

/* The organisation's own name and logo, shown on the sign-in screen and at the top of every page. Both live with the other
 * settings; the logo file is one object in the R2 bucket. Until the wizard sets them, the app shows its own name. */

const LOGO = 'brand/logo';
const MAX_LOGO = 512 * 1024;

export type Brand = { name: string; logo: string | null };
export type Logo = { type: string; bytes: Uint8Array };

export async function settings(env: Env) {
  const rows = (await env.DB.prepare('SELECT key,value FROM setting').all<{ key: string; value: string }>()).results;
  return Object.fromEntries(rows.map(row => [row.key, row.value])) as Record<string, string | undefined>;
}

export const brandOf = (saved: Record<string, string | undefined>): Brand =>
  ({ name: saved.org_name || PRODUCT, logo: saved.logo_at ? `/api/brand/logo?v=${saved.logo_at}` : null });

/** A logo sent from the page as a data: URL. Only PNG, JPEG and WebP up to 512 KB: plain pictures that can't carry script. */
export function readLogo(value: unknown): Logo | 'bad' {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(String(value ?? ''));
  if (!match) return 'bad';
  const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
  return bytes.length && bytes.length <= MAX_LOGO ? { type: match[1], bytes } : 'bad';
}
export const badLogo = () => json({ error: 'Use a PNG, JPEG or WebP picture under 512 KB for the logo.' }, 400);

/** Stores the logo file, or removes it with null. */
export async function saveLogo(env: Env, logo: Logo | null) {
  if (logo) {
    await env.FILES.put(LOGO, logo.bytes, { httpMetadata: { contentType: logo.type } });
    await env.DB.prepare("INSERT OR REPLACE INTO setting(key,value) VALUES('logo_at',?1)").bind(String(Date.now())).run();
  } else {
    await env.FILES.delete(LOGO);
    await env.DB.prepare("DELETE FROM setting WHERE key='logo_at'").run();
  }
}

/** GET /api/brand/logo: anyone may load it, since the sign-in screen shows it. */
export async function logoFile(env: Env) {
  const object = await env.FILES.get(LOGO);
  if (!object) return json({ error: 'Not found.' }, 404);
  return new Response(object.body, { headers: { 'content-type': object.httpMetadata?.contentType || 'application/octet-stream',
    'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'public, max-age=86400' } });
}

/** PUT /api/brand {name?, logo?}, owner only. A logo of null removes it; leaving `logo` out keeps it. */
export async function updateBrand(request: Request, env: Env, account: Account) {
  if (account.role !== 'owner') return json({ error: 'Only the owner can change this.' }, 403);
  const input = await readJson<{ name: string; logo: string | null }>(request);
  if (input.name !== undefined) {
    const name = cleanName(input.name);
    if (!name) return json({ error: 'Add your organisation’s name.' }, 400);
    await env.DB.prepare("INSERT OR REPLACE INTO setting(key,value) VALUES('org_name',?1)").bind(name).run();
  }
  if (input.logo !== undefined) {
    const logo = input.logo === null ? null : readLogo(input.logo);
    if (logo === 'bad') return badLogo();
    await saveLogo(env, logo);
  }
  return json({ brand: brandOf(await settings(env)) });
}
