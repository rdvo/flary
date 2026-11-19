import PostalMime from 'postal-mime';
import type { Account } from './auth';
import { json, ourAddress, plainHtml, readJson, type Env } from './util';

/* Privacy rests on this file. A `Box` can only be made here: by `openMailbox`, which checks the signed-in account is a
 * member, by `myMailboxes`, which lists only those, or by `deliveryMailbox` for the email handler. Every statement on the
 * message table goes through `scoped`, which refuses SQL without `mailbox_id=?1` (or an INSERT whose mailbox_id is ?1)
 * and always binds ?1 to the box's id.
 * Other parameters are numbered from ?2. `purgeMailbox` is the one exception: it deletes a whole mailbox for the owner. */
declare const verified: unique symbol;
export type Box = { readonly id: string; readonly address: string; readonly name: string; readonly [verified]: true };
type BoxRow = { id: string; address: string; name: string; kind: 'personal' | 'shared' };

export async function openMailbox(env: Env, account: Account, id: string | null): Promise<Box | null> {
  if (!id) return null;
  return await env.DB.prepare('SELECT m.id,m.address,m.name FROM mailbox m JOIN mailbox_member mm ON mm.mailbox_id=m.id WHERE m.id=?1 AND mm.account_id=?2')
    .bind(id, account.id).first<Box>() ?? null;
}

/** The mailbox a received message is for: one with that address, or the one an alias of it points to. */
export async function deliveryMailbox(env: Env, address: string): Promise<Box | null> {
  return await env.DB.prepare('SELECT m.id,m.address,m.name FROM mailbox m WHERE m.address=?1 UNION ALL SELECT m.id,m.address,m.name FROM alias a JOIN mailbox m ON m.id=a.mailbox_id WHERE a.address=?1 LIMIT 1')
    .bind(address).first<Box>() ?? null;
}

/** The SQL outside quotes and parentheses, where an OR could widen `mailbox_id=?1 AND …` to other mailboxes. */
function topLevel(sql: string) {
  let depth = 0, out = '';
  for (const char of sql.replace(/'(?:[^']|'')*'/g, "''")) {
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (!depth) out += char;
  }
  return out;
}

export function scoped(env: Env, box: Box, sql: string, ...args: unknown[]) {
  const ok = /\bmailbox_id=\?1(?!\d)/.test(sql) || /^INSERT (?:OR IGNORE )?INTO message\(mailbox_id,[^)]*\) VALUES\(\?1,/.test(sql);
  if (!ok || /\bOR\b/i.test(topLevel(sql).replace(/^INSERT OR IGNORE\b/i, ''))) throw new Error('A message query must be scoped to one mailbox.');
  return env.DB.prepare(sql).bind(box.id, ...args);
}
const slots = (from: number, count: number) => Array.from({ length: count }, (_, index) => `?${from + index}`).join(',');

/** The mailboxes this account can open (its own first), each with its unread conversation count. */
export async function myMailboxes(env: Env, account: Account) {
  const rows = (await env.DB.prepare('SELECT m.id,m.address,m.name,m.kind FROM mailbox m JOIN mailbox_member mm ON mm.mailbox_id=m.id WHERE mm.account_id=?1 ORDER BY m.id=?2 DESC,m.kind,m.address')
    .bind(account.id, account.mailboxId).all<BoxRow>()).results;
  const counts = rows.length ? await env.DB.batch<{ n: number }>(rows.map(row => scoped(env, row as unknown as Box, "SELECT COUNT(DISTINCT thread_id) AS n FROM message WHERE mailbox_id=?1 AND folder='inbox' AND read_at IS NULL"))) : [];
  return rows.map((row, index) => ({ ...row, unread: Number(counts[index]?.results[0]?.n || 0) }));
}

/** Deletes a mailbox with all its mail. The owner calls this from the org panel, only for a mailbox nobody signs in to. */
export async function purgeMailbox(env: Env, context: ExecutionContext, id: string) {
  const results = await env.DB.batch([
    env.DB.prepare('DELETE FROM message WHERE mailbox_id=?1 AND NOT EXISTS (SELECT 1 FROM account WHERE mailbox_id=?1)').bind(id),
    env.DB.prepare('DELETE FROM alias WHERE mailbox_id=?1 AND NOT EXISTS (SELECT 1 FROM account WHERE mailbox_id=?1)').bind(id),
    env.DB.prepare('DELETE FROM mailbox_member WHERE mailbox_id=?1 AND NOT EXISTS (SELECT 1 FROM account WHERE mailbox_id=?1)').bind(id),
    env.DB.prepare('DELETE FROM mailbox WHERE id=?1 AND NOT EXISTS (SELECT 1 FROM account WHERE mailbox_id=?1)').bind(id),
  ]);
  if ((results[3].meta.changes ?? 0) < 1) return false;
  context.waitUntil((async () => {
    let cursor: string | undefined;
    do {
      const page = await env.FILES.list({ prefix: `mail/${id}/`, cursor, limit: 1000 });
      if (page.objects.length) await env.FILES.delete(page.objects.map(object => object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  })().catch(error => console.warn('purge_files_failed', error instanceof Error ? error.message : error)));
  return true;
}

type MailFile = { name: string; type: string; size: number; cid?: string };
type Row = Record<string, string | number | null>;
const bare = (value: string) => value.trim().replace(/^<|>$/g, '');
const idList = (value: string) => [...value.matchAll(/<([^<>\s]{1,500})>/g)].map(match => match[1]).slice(-30);
const people = (value: unknown, limit = 50) => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;\n]/) : []).map(item => String(item).trim().toLowerCase())
  .filter(item => /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(item) && item.length <= 254).filter((item, index, all) => all.indexOf(item) === index).slice(0, limit);
const fileKey = (box: Box, id: string, index: number) => `mail/${box.id}/${id}/${index}`;
const safeName = (name: string) => (name || 'attachment').replace(/[\u0000-\u001f/\\"]/g, '_').slice(0, 180);

/** A Message-ID as stored: without angle brackets, and only when it looks like one (left@right, no spaces). */
const messageIdOf = (value: unknown) => { const id = bare(String(value ?? '')); return /^[^\s<>@]{1,400}@[^\s<>@]{1,400}$/.test(id) ? id : null; };
/** A subject without its Re:/Fwd: prefixes, for matching a reply to the message it answers. */
const topicOf = (subject: unknown) => String(subject ?? '').replace(/^\s*(?:(?:re|fwd?|aw|sv|antw|wg)\s*(?:\[\d+\])?\s*:\s*)+/i, '').trim().toLowerCase();
/** In-Reply-To and References for a reply. Cloudflare caps a header value at 2,048 bytes, so the oldest ids after the first are
 * dropped until the References line fits (RFC 5322 keeps the first and the most recent). */
function replyHeaders(parent: string, chain: string[]): Record<string, string> {
  if (!parent) return {};
  const ids = [...chain];
  const line = () => ids.map(item => `<${item}>`).join(' ');
  while (ids.length > 2 && new TextEncoder().encode(line()).byteLength > 2000) ids.splice(1, 1);
  if (new TextEncoder().encode(line()).byteLength > 2000) ids.splice(0, ids.length - 1);
  return { 'In-Reply-To': `<${parent}>`, References: line() };
}

/** The conversation a received message belongs to: the one holding any message it names in References or In-Reply-To. A reply
 * that names none we have (for example a reply to one of our sent messages whose id we could not record) joins the newest
 * conversation of the last 90 days where this mailbox wrote to that sender under the same subject. */
async function threadFor(env: Env, box: Box, references: string[], subject: string, sender: string) {
  if (!references.length) return null;
  const found = await scoped(env, box, `SELECT thread_id AS t FROM message WHERE mailbox_id=?1 AND message_id IN (${slots(2, references.length)}) ORDER BY received_at DESC LIMIT 1`, ...references).first<{ t: string }>();
  if (found) return found.t;
  const topic = topicOf(subject);
  if (!topic || !sender) return null;
  const like = `%${sender.replace(/[\\%_]/g, '\\$&')}%`;
  const sent = await scoped(env, box, "SELECT thread_id AS t,subject FROM message WHERE mailbox_id=?1 AND auth='sent' AND received_at>?2 AND (recipient LIKE ?3 ESCAPE '\\' OR cc LIKE ?3 ESCAPE '\\' OR bcc LIKE ?3 ESCAPE '\\') ORDER BY received_at DESC LIMIT 50",
    Date.now() - 90 * 86_400_000, like).all<{ t: string; subject: string }>();
  return sent.results.find(row => topicOf(row.subject) === topic)?.t ?? null;
}

/** The email handler: mail to a mailbox or alias on this domain is kept whole; anything else is refused. */
export async function receive(message: ForwardableEmailMessage, env: Env) {
  const address = ourAddress(env, message.to), box = address ? await deliveryMailbox(env, address) : null;
  if (!box) { message.setReject('No such mailbox here.'); return; }
  if (message.rawSize > 25 * 1024 * 1024) { message.setReject('Message too large.'); return; }
  const mail = await PostalMime.parse(await new Response(message.raw).arrayBuffer());
  const authentication = (message.headers.get('authentication-results') || '').split(/,(?=\s*[^;]+;)/)[0];
  // Only Cloudflare's own prepended result is trusted. A failed sender check files the message under Spam; nothing is dropped.
  const auth = /^\s*mx\.cloudflare\.net\s*;/i.test(authentication) ? (/\bdmarc=(\w+)/i.exec(authentication)?.[1] || 'none').toLowerCase() : 'unknown';
  const id = crypto.randomUUID(), messageId = bare(mail.messageId || '') || null;
  if (messageId && await scoped(env, box, 'SELECT 1 FROM message WHERE mailbox_id=?1 AND message_id=?2', messageId).first()) return;
  const sender = (mail.from?.address || message.from || '').trim().toLowerCase().slice(0, 320);
  const references = idList(`${mail.references || ''} ${mail.inReplyTo || ''}`), thread = await threadFor(env, box, references, mail.subject || '', sender) ?? id;
  const files: MailFile[] = [];
  for (const file of mail.attachments.slice(0, 30)) {
    const data = typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content;
    try {
      await env.FILES.put(fileKey(box, id, files.length), data, { httpMetadata: { contentType: file.mimeType || 'application/octet-stream' } });
      files.push({ name: safeName(file.filename || ''), type: file.mimeType || 'application/octet-stream', size: data.byteLength, ...(file.contentId ? { cid: bare(file.contentId) } : {}) });
    } catch (error) { console.warn('attachment_save_failed', error instanceof Error ? error.message : error); }
  }
  const html = (mail.html || '').slice(0, 600_000), body = (mail.text || plainHtml(html)).trim().slice(0, 200_000);
  const list = (items: { address?: string }[] | undefined) => (items || []).map(item => (item.address || '').toLowerCase()).filter(Boolean).slice(0, 50).join(', ');
  await scoped(env, box, 'INSERT OR IGNORE INTO message(mailbox_id,id,message_id,recipient,sender,sender_name,subject,body,html,auth,received_at,folder,thread_id,cc,attachments,refs) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)',
    id, messageId, list(mail.to) || address, sender, (mail.from?.name || '').slice(0, 200),
    (mail.subject || '(no subject)').slice(0, 500), body, html || null, auth, Date.now(), auth === 'fail' ? 'spam' : 'inbox', thread, list(mail.cc), JSON.stringify(files), references.join(' ')).run();
}

// Where each folder looks; "all" is everything that isn't spam, trash or an unsent draft.
const FOLDERS: Record<string, string> = { inbox: "folder='inbox'", starred: "starred=1 AND folder NOT IN ('trash','spam')", sent: "folder='sent'", drafts: "folder='drafts'",
  all: "folder NOT IN ('trash','spam','drafts')", spam: "folder='spam'", trash: "folder='trash'" };
const COLUMNS = 'id,thread_id AS threadId,message_id AS messageId,recipient,cc,bcc,sender,sender_name AS senderName,subject,auth,folder,starred,attachments,received_at AS receivedAt,read_at AS readAt';

async function listThreads(env: Env, url: URL, box: Box) {
  const folder = FOLDERS[url.searchParams.get('folder') || ''] ? url.searchParams.get('folder')! : 'inbox', q = (url.searchParams.get('q') || '').trim().slice(0, 120);
  const offset = Math.max(0, Math.min(100_000, Math.floor(Number(url.searchParams.get('offset')) || 0))), like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const where = `mailbox_id=?1 AND ${FOLDERS[folder]}${q ? " AND (subject LIKE ?2 ESCAPE '\\' OR body LIKE ?2 ESCAPE '\\' OR sender LIKE ?2 ESCAPE '\\' OR sender_name LIKE ?2 ESCAPE '\\' OR recipient LIKE ?2 ESCAPE '\\')" : ''}`;
  const args = q ? [like] : [];
  const [page, total, counts] = await env.DB.batch<Row>([
    scoped(env, box, `SELECT thread_id AS t,MAX(received_at) AS at FROM message WHERE ${where} GROUP BY thread_id ORDER BY at DESC LIMIT 50 OFFSET ${offset}`, ...args),
    scoped(env, box, `SELECT COUNT(DISTINCT thread_id) AS n FROM message WHERE ${where}`, ...args),
    scoped(env, box, "SELECT folder,COUNT(DISTINCT CASE WHEN read_at IS NULL OR folder='drafts' THEN thread_id END) AS n FROM message WHERE mailbox_id=?1 GROUP BY folder"),
  ]);
  const ids = page.results.map(row => String(row.t));
  // A conversation shows as one row: who is in it, how many messages, and its latest message, wherever its parts are filed.
  const place = folder === 'trash' ? "folder='trash'" : folder === 'spam' ? "folder='spam'" : "folder NOT IN ('trash','spam')";
  const rows = ids.length ? (await scoped(env, box, `SELECT ${COLUMNS},substr(body,1,180) AS preview FROM message WHERE mailbox_id=?1 AND thread_id IN (${slots(2, ids.length)}) AND ${place} ORDER BY received_at`, ...ids).all<Row>()).results : [];
  const threads = ids.map(id => {
    const parts = rows.filter(row => row.threadId === id), last = parts.at(-1);
    if (!last) return null;
    const names = parts.map(row => row.auth === 'draft' ? 'Draft' : row.auth === 'sent' ? 'me' : String(row.senderName || row.sender).split('@')[0]).filter((name, index, all) => all.indexOf(name) === index);
    return { id, count: parts.length, names, subject: parts[0].subject, preview: last.preview, at: last.receivedAt, unread: parts.some(row => !row.readAt && row.auth !== 'draft'), starred: parts.some(row => row.starred),
      files: parts.some(row => row.attachments !== '[]'), draft: last.auth === 'draft' ? last.id : null, to: last.auth === 'sent' || last.auth === 'draft' ? last.recipient : null };
  }).filter(Boolean);
  const count = (name: string) => Number(counts.results.find(row => row.folder === name)?.n || 0);
  return json({ address: box.address, name: box.name, folder, total: Number(total.results[0]?.n || 0), offset, threads, counts: { inbox: count('inbox'), drafts: count('drafts'), spam: count('spam') } });
}

async function send(request: Request, env: Env, box: Box) {
  // A box's address is always on this domain; checked again here because this is where mail leaves.
  if (!env.MAIL) return json({ error: 'Sending isn’t set up on this Worker.' }, 503);
  if (ourAddress(env, box.address) !== box.address) return json({ error: 'This mailbox can’t send.' }, 403);
  const input = await readJson<{ to: unknown; cc: unknown; bcc: unknown; subject: string; text: string; html: string; replyTo: string; draft: string; files: { name?: string; type?: string; data?: string }[] }>(request);
  const to = people(input.to), cc = people(input.cc), bcc = people(input.bcc), subject = String(input.subject || '').trim().slice(0, 300) || '(no subject)';
  const text = String(input.text || '').trim().slice(0, 200_000), html = String(input.html || '').slice(0, 600_000), attached = Array.isArray(input.files) ? input.files : [];
  if (!to.length && !cc.length && !bcc.length) return json({ error: 'Add at least one recipient.' }, 400);
  if (to.length + cc.length + bcc.length > 50) return json({ error: 'A message can go to at most 50 people.' }, 400);
  if (!text && !attached.length) return json({ error: 'Write a message first.' }, 400);
  const files: { name: string; type: string; data: Uint8Array }[] = []; let total = 0;
  for (const file of attached.slice(0, 20)) {
    let data: Uint8Array;
    try { data = Uint8Array.from(atob(String(file.data || '')), char => char.charCodeAt(0)); } catch { return json({ error: `Could not read the attachment ${safeName(String(file.name || ''))}.` }, 400); }
    total += data.byteLength;
    if (total > 18 * 1024 * 1024) return json({ error: 'Attachments are limited to 18 MB a message.' }, 413);
    files.push({ name: safeName(String(file.name || '')), type: /^[\w.+-]+\/[\w.+-]+$/.test(String(file.type || '')) ? String(file.type) : 'application/octet-stream', data });
  }
  // A reply carries the original's message id and its chain so it threads in the recipient's mail.
  const original = input.replyTo ? await scoped(env, box, 'SELECT message_id AS messageId,refs,thread_id AS t FROM message WHERE mailbox_id=?1 AND id=?2', String(input.replyTo)).first<{ messageId: string | null; refs: string; t: string }>() : null;
  const parent = messageIdOf(original?.messageId) || '', chain = [...(original?.refs || '').split(' ').filter(Boolean), ...(parent ? [parent] : [])].map(messageIdOf).filter((item): item is string => Boolean(item)).slice(-20);
  const id = crypto.randomUUID();
  try {
    const sent = await env.MAIL.send({ from: { email: box.address, name: box.name }, ...(to.length ? { to } : {}), ...(cc.length ? { cc } : {}), ...(bcc.length ? { bcc } : {}), subject, text: text || ' ', ...(html ? { html } : {}),
      // Cloudflare sets Message-ID itself (setting it is refused with E_HEADER_NOT_ALLOWED) and returns it from send().
      ...(parent ? { headers: replyHeaders(parent, chain) } : {}),
      ...(files.length ? { attachments: files.map(file => ({ disposition: 'attachment' as const, filename: file.name, type: file.type, content: file.data })) } : {}) });
    const saved: MailFile[] = [];
    for (const file of files) {
      try { await env.FILES.put(fileKey(box, id, saved.length), file.data, { httpMetadata: { contentType: file.type } }); saved.push({ name: file.name, type: file.type, size: file.data.byteLength }); }
      catch { /* The message went out; only the kept copy lacks this file. */ }
    }
    const now = Date.now();
    await env.DB.batch([
      scoped(env, box, "INSERT OR IGNORE INTO message(mailbox_id,id,message_id,recipient,sender,sender_name,subject,body,html,auth,received_at,read_at,folder,thread_id,cc,bcc,attachments,refs) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'sent',?10,?10,'sent',?11,?12,?13,?14,?15)",
        id, messageIdOf(sent.messageId), to.join(', '), box.address, box.name, subject, text, html || null, now, original?.t ?? id, cc.join(', '), bcc.join(', '), JSON.stringify(saved), chain.join(' ')),
      ...(input.draft ? [scoped(env, box, "DELETE FROM message WHERE mailbox_id=?1 AND id=?2 AND folder='drafts'", String(input.draft))] : []),
    ]);
    return json({ sent: true, id });
  } catch (error) {
    console.warn('send_failed', error instanceof Error ? error.message : error);
    return json({ error: `The message was not sent: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}` }, 502);
  }
}

async function saveDraft(request: Request, env: Env, box: Box) {
  const input = await readJson<{ id: string; to: string; cc: string; bcc: string; subject: string; text: string; html: string; replyTo: string }>(request);
  const id = /^[0-9a-f-]{36}$/.test(String(input.id || '')) ? String(input.id) : crypto.randomUUID(), clip = (value: unknown, size: number) => String(value ?? '').slice(0, size);
  const original = input.replyTo ? await scoped(env, box, 'SELECT thread_id AS t FROM message WHERE mailbox_id=?1 AND id=?2', String(input.replyTo)).first<{ t: string }>() : null;
  // refs holds the message a draft answers, so reopening it still sends as a reply. A draft id from another mailbox matches no row here and changes nothing.
  await scoped(env, box, `INSERT INTO message(mailbox_id,id,recipient,sender,sender_name,subject,body,html,auth,received_at,read_at,folder,thread_id,cc,bcc,refs) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'draft',?9,?9,'drafts',?10,?11,?12,?13)
    ON CONFLICT(id) DO UPDATE SET recipient=?3,subject=?6,body=?7,html=?8,received_at=?9,cc=?11,bcc=?12 WHERE folder='drafts' AND mailbox_id=?1`,
    id, clip(input.to, 4000), box.address, box.name, clip(input.subject, 300), clip(input.text, 200_000), clip(input.html, 600_000) || null, Date.now(), original?.t ?? id, clip(input.cc, 4000), clip(input.bcc, 4000), original ? String(input.replyTo) : '').run();
  return json({ id });
}

async function act(request: Request, env: Env, box: Box) {
  const input = await readJson<{ threads: unknown; action: string; id: string }>(request);
  // Discarding names the one draft, so a reply draft never takes its conversation's other parts with it.
  if (input.action === 'discard') { await scoped(env, box, "DELETE FROM message WHERE mailbox_id=?1 AND id=?2 AND folder='drafts'", String(input.id || '')).run(); return json({ done: true }); }
  const threads = (Array.isArray(input.threads) ? input.threads : []).filter((id): id is string => typeof id === 'string' && id.length <= 64).slice(0, 80);
  if (!threads.length) return json({ error: 'Nothing selected.' }, 400);
  const scope = `mailbox_id=?1 AND thread_id IN (${slots(2, threads.length)})`, now = Date.now();
  const run = (sql: string) => scoped(env, box, sql, ...threads).run();
  switch (input.action) {
    case 'read': await run(`UPDATE message SET read_at=${now} WHERE ${scope} AND read_at IS NULL`); break;
    case 'unread': await run(`UPDATE message SET read_at=NULL WHERE ${scope} AND auth NOT IN ('sent','draft')`); break;
    case 'star': await run(`UPDATE message SET starred=1 WHERE ${scope}`); break;
    case 'unstar': await run(`UPDATE message SET starred=0 WHERE ${scope}`); break;
    case 'archive': await run(`UPDATE message SET folder='archive' WHERE ${scope} AND folder='inbox'`); break;
    case 'spam': await run(`UPDATE message SET folder='spam' WHERE ${scope} AND auth NOT IN ('sent','draft')`); break;
    case 'trash': await run(`UPDATE message SET folder='trash' WHERE ${scope}`); break;
    // Out of Archive, Spam or Trash, each message goes back to where its kind lives.
    case 'restore': await run(`UPDATE message SET folder=CASE auth WHEN 'sent' THEN 'sent' WHEN 'draft' THEN 'drafts' ELSE 'inbox' END WHERE ${scope} AND folder IN ('archive','spam','trash')`); break;
    case 'delete': {
      const gone = await scoped(env, box, `SELECT id,attachments FROM message WHERE ${scope} AND folder IN ('trash','drafts','spam')`, ...threads).all<{ id: string; attachments: string }>();
      const keys = gone.results.flatMap(row => (JSON.parse(row.attachments || '[]') as MailFile[]).map((_, index) => fileKey(box, row.id, index)));
      await run(`DELETE FROM message WHERE ${scope} AND folder IN ('trash','drafts','spam')`);
      if (keys.length) await env.FILES.delete(keys.slice(0, 1000)).catch(() => undefined);
      break;
    }
    default: return json({ error: 'Unknown action.' }, 400);
  }
  return json({ done: true });
}

async function attachment(env: Env, box: Box, id: string, index: number) {
  const row = await scoped(env, box, 'SELECT attachments FROM message WHERE mailbox_id=?1 AND id=?2', id).first<{ attachments: string }>();
  const meta = (JSON.parse(row?.attachments || '[]') as MailFile[])[index], object = meta ? await env.FILES.get(fileKey(box, id, index)) : null;
  if (!meta || !object) return json({ error: 'Not found.' }, 404);
  // Only plain images and PDFs open in the browser; anything else downloads, so a received file can never run as a page here.
  const inline = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(meta.type);
  return new Response(object.body, { headers: { 'content-type': inline ? meta.type : 'application/octet-stream',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${meta.name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
    'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=3600', 'content-security-policy': "default-src 'none'; sandbox" } });
}

/** /api/mail/… for a signed-in account. `?box=` names the mailbox; it must be one the account is a member of. */
export async function mailRoute(request: Request, env: Env, account: Account, path: string) {
  const url = new URL(request.url), box = await openMailbox(env, account, url.searchParams.get('box') || account.mailboxId);
  if (!box) return json({ error: 'Not found.' }, 404);
  if (request.method === 'POST' && path === 'send') return send(request, env, box);
  if (request.method === 'PUT' && path === 'draft') return saveDraft(request, env, box);
  if (request.method === 'PATCH' && !path) return act(request, env, box);
  if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  if (!path) return listThreads(env, url, box);
  const file = /^file\/([0-9a-f-]{36})\/(\d{1,2})$/.exec(path);
  if (file) return attachment(env, box, file[1], Number(file[2]));
  const thread = /^thread\/([A-Za-z0-9-]{1,64})$/.exec(path);
  if (!thread) return json({ error: 'Not found.' }, 404);
  const rows = await scoped(env, box, `SELECT ${COLUMNS},body,html,refs FROM message WHERE mailbox_id=?1 AND thread_id=?2 ORDER BY received_at`, thread[1]).all<Row>();
  if (!rows.results.length) return json({ error: 'Not found.' }, 404);
  // Opening a conversation is what marks it read; `peek` is the page fetching ahead on hover, which must not.
  if (!url.searchParams.has('peek') && rows.results.some(row => !row.readAt)) await scoped(env, box, 'UPDATE message SET read_at=?3 WHERE mailbox_id=?1 AND thread_id=?2 AND read_at IS NULL', thread[1], Date.now()).run();
  return json({ address: box.address, messages: rows.results.map(row => ({ ...row, attachments: JSON.parse(String(row.attachments || '[]')) })) });
}
