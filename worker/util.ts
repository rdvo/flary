import product from '../product.json';

/** The structured form of the Cloudflare Email Service `send_email` binding. */
export interface MailBinding {
  send(message: {
    from: { email: string; name: string };
    to?: string[]; cc?: string[]; bcc?: string[];
    subject: string; text?: string; html?: string;
    headers?: Record<string, string>;
    attachments?: { disposition: 'attachment' | 'inline'; filename: string; type: string; content: ArrayBuffer | ArrayBufferView | string; contentId?: string }[];
  }): Promise<{ messageId: string }>;
}

/** What the runtime hands the Worker. The domain is picked in the setup wizard and kept in `setting`; a DOMAIN variable, if
 * set, wins. CF_API_TOKEN is the Cloudflare token given at install, kept as a secret so setup never asks for it again. */
export type Bindings = {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  MAIL?: MailBinding;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  DOMAIN?: string;
  SETUP_TOKEN?: string;
  CF_API_TOKEN?: string;
};
/** The bindings with the mail domain settled (empty until the first-run screen has run). */
export type Env = Bindings & { DOMAIN: string };

export const PRODUCT: string = product.name;

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

export const readJson = async <T>(request: Request): Promise<Partial<T>> => {
  const value = await request.json().catch(() => null);
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<T> : {};
};

export const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes as ArrayBuffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
export const randomHex = (size: number) => hex(crypto.getRandomValues(new Uint8Array(size)));
export const sha = async (value: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));

export const domainOf = (env: Env) => env.DOMAIN.trim().toLowerCase();
export const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The part before the @ of an address people can be given: no "+", which is kept for tags. */
const LOCAL = /^[a-z0-9][a-z0-9._-]{0,62}$/;
export const localPart = (value: unknown) => {
  const local = String(value ?? '').trim().toLowerCase();
  return LOCAL.test(local) && !local.endsWith('.') && !local.includes('..') ? local : null;
};

/** The address as stored here when it is on this domain (lower case, any +tag dropped), otherwise null. */
export function ourAddress(env: Env, value: unknown) {
  const address = String(value ?? '').trim().toLowerCase(), at = address.lastIndexOf('@');
  if (at < 1 || address.slice(at + 1) !== domainOf(env)) return null;
  const local = localPart(address.slice(0, at).split('+')[0]);
  return local ? `${local}@${domainOf(env)}` : null;
}

export const cleanName = (value: unknown, size = 80) => String(value ?? '').replace(/[\u0000-\u001f<>"]/g, '').trim().slice(0, size);

/** HTML to readable text, for previews and search when a message has no text part. */
export const plainHtml = (html: string) => html.replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  .replace(/<br\s*\/?\s*>|<\/(p|div|li|tr|h[1-6])>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&amp;/gi, '&');

export const changed = (result: D1Result) => (result.meta.changes ?? 0) >= 1;
