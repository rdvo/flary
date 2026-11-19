import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArchiveIcon, ArrowsClockwiseIcon, ArrowBendDoubleUpLeftIcon, ArrowBendUpLeftIcon, ArrowBendUpRightIcon, ArrowLeftIcon, CaretLeftIcon, CaretRightIcon, CheckIcon, DotsThreeIcon, EnvelopeOpenIcon, EnvelopeSimpleIcon, FileIcon, LinkIcon,
  ListBulletsIcon, ListIcon, ListNumbersIcon, MagnifyingGlassIcon, MinusIcon, PaperPlaneRightIcon, PaperclipIcon, PencilSimpleIcon, StackIcon, StarIcon, TextBIcon, TextItalicIcon, TextUnderlineIcon, TrashIcon, TrayArrowDownIcon, TrayIcon,
  PasswordIcon, SignOutIcon, UsersIcon, WarningOctagonIcon, XIcon, type Icon } from '@phosphor-icons/react';
import product from '../product.json';
import { api, dark, navigate, onSchemeChange, useData, type MailboxInfo, type Session } from './api';
import styles from './mail.module.css';

type Folder = 'inbox' | 'starred' | 'sent' | 'drafts' | 'all' | 'spam' | 'trash';
type Thread = { id: string; count: number; names: string[]; subject: string; preview: string; at: number; unread: boolean; starred: boolean; files: boolean; draft: string | null; to: string | null };
type List = { address: string; name: string; folder: Folder; total: number; offset: number; threads: Thread[]; counts: { inbox: number; drafts: number; spam: number } };
type FileMeta = { name: string; type: string; size: number; cid?: string };
type Message = { id: string; threadId: string; recipient: string; cc: string; bcc: string; sender: string; senderName: string; subject: string; auth: string; folder: string; starred: number; attachments: FileMeta[];
  receivedAt: number; body: string; html: string | null; refs: string };
type Draft = { id?: string; to: string; cc: string; bcc: string; subject: string; html: string; replyTo?: string; inline?: boolean; files?: File[] };
/** Builds a mail API path for the open mailbox. */
type MailUrl = (path: string) => string;
// What the bar at the bottom says after an action, and the action that undoes it.
const DONE: Record<string, [string, string?]> = { archive: ['archived', 'restore'], trash: ['moved to Trash', 'restore'], spam: ['marked as spam', 'restore'], restore: ['moved to Inbox'], delete: ['deleted forever'],
  read: ['marked as read', 'unread'], unread: ['marked as unread', 'read'] };

const FOLDERS: [Folder, string, Icon][] = [['inbox', 'Inbox', TrayIcon], ['starred', 'Starred', StarIcon], ['sent', 'Sent', PaperPlaneRightIcon], ['drafts', 'Drafts', FileIcon], ['all', 'All Mail', StackIcon], ['spam', 'Spam', WarningOctagonIcon], ['trash', 'Trash', TrashIcon]];
const BLANK: Draft = { to: '', cc: '', bcc: '', subject: '', html: '' };
const stamp = (at: number, full = false) => {
  const date = new Date(at), now = new Date(), time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (full) return `${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric' })}, ${time}`;
  return date.toDateString() === now.toDateString() ? time : date.toLocaleDateString(undefined, date.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'numeric', day: 'numeric', year: '2-digit' });
};
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
const escape = (text: string) => text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);
const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
// Each sender keeps one colour, picked from their name.
const tint = (name: string) => `hsl(${[...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7)} 42% 46%)`;
const initial = (name: string) => (name.trim()[0] || '?').toUpperCase();
// The original is quoted as escaped text, never as its own HTML, so nothing a sender wrote can run in this page.
// It uses Gmail's quote markup, so Gmail and this page both fold the quoted part away.
const quote = (message: Message) => `<br><br><div class="gmail_quote"><div class="gmail_attr">On ${escape(stamp(message.receivedAt, true))}, ${escape(message.senderName ? `${message.senderName} <${message.sender}>` : message.sender)} wrote:<br></div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${escape(message.body).replace(/\n/g, '<br>')}</blockquote></div>`;
// The new part of a message, without the "On … wrote:" quote under it, for one-line previews.
const fresh = (text: string) => text.split(/(?:^|\s)On [^\n]{5,160}? wrote:|\n>/)[0].trim() || text;
const forwarded = (message: Message) => `<br><br><div>---------- Forwarded message ---------<br>From: ${escape(message.senderName ? `${message.senderName} <${message.sender}>` : message.sender)}<br>Date: ${escape(stamp(message.receivedAt, true))}<br>Subject: ${escape(message.subject)}<br>To: ${escape(message.recipient)}</div><br><div>${escape(message.body).replace(/\n/g, '<br>')}</div>`;
const prefixed = (prefix: string, subject: string) => new RegExp(`^${prefix}:`, 'i').test(subject) ? subject : `${prefix}: ${subject}`;

function Tool({ label, icon: ToolIcon, onClick, disabled, on }: { label: string; icon: Icon; onClick: () => void; disabled?: boolean; on?: boolean }) {
  return <button type="button" className={styles.ib} aria-label={label} title={label} disabled={disabled} data-on={on || undefined} onMouseDown={event => event.preventDefault()} onClick={event => { event.stopPropagation(); onClick(); }}><ToolIcon size={18} weight={on ? 'fill' : 'regular'} /></button>;
}

/** A received message's own HTML, in a frame that can run no script and load nothing but images, fonts and styles. */
function MailBody({ message, url }: { message: Message; url: MailUrl }) {
  const frame = useRef<HTMLIFrameElement>(null), [height, setHeight] = useState(60), [trimmed, setTrimmed] = useState(false), [all, setAll] = useState(false);
  // A designed email (one that sets its own backgrounds) keeps its colours on a white card; only plain messages go dark with the scheme.
  const designed = useMemo(() => /bgcolor\s*=|background(?:-color|-image)?\s*:/i.test(message.html || ''), [message]);
  const darkNow = useCallback(() => !designed && dark(), [designed]);
  const source = useMemo(() => {
    const html = (message.html || '').replace(/cid:([^"'\s)>]+)/gi, (match, cid: string) => { const index = message.attachments.findIndex(file => file.cid === cid); return index < 0 ? match : url(`/file/${message.id}/${index}`); });
    // Emails often force html and body to height:100%, which would pin the message to the frame's own height; the data-mail rules outrank that.
    // Mail filed as spam, or that failed the sender check, loads no outside pictures, so a tracking pixel can't confirm the address.
    const remote = message.folder !== 'spam' && message.auth !== 'fail' ? 'https: ' : '';
    return `<!doctype html><html data-mail${designed ? ' data-designed' : ''}${darkNow() ? ' data-dark' : ''}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${remote}data: ${location.origin}; style-src 'unsafe-inline'; font-src https: data:"><base target="_blank"><style>html,body{margin:0}html[data-mail],html[data-mail] body{height:auto!important;min-height:0!important}html[data-mail]{overflow-y:hidden}html{background:#fff}html[data-dark]{background:#202020}html[data-dark] body{background:#dfdfdf;filter:invert(1) hue-rotate(180deg)}html[data-dark] img,html[data-dark] video{filter:invert(1) hue-rotate(180deg)}body{padding:0;font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#202124;overflow-wrap:break-word}html:not([data-designed]) img{max-width:100%;height:auto}table{max-width:100%}blockquote{margin:0 0 0 6px;padding-left:12px;border-left:2px solid #c8ccd0;color:#5f6368}[data-trim]{display:none!important}body[data-all] [data-trim]{display:revert!important}</style></head><body>${html}</body></html>`;
  }, [message, designed, darkNow, url]);
  const fit = useCallback(() => {
    const page = frame.current?.contentDocument;
    if (!page?.body) return;
    for (const link of page.querySelectorAll('a')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    page.documentElement.toggleAttribute('data-dark', darkNow());
    // The earlier message quoted under a reply folds away behind a button, unless the quote is all there is.
    const quoted = page.querySelector('.gmail_quote, blockquote[type="cite"], #divRplyFwdMsg, blockquote');
    if (quoted) {
      const lead = quoted.previousElementSibling, intro = lead?.textContent || '';
      const parts: Element[] = [quoted, ...(lead && intro.length < 240 && /wrote:\s*$/.test(intro) ? [lead] : []), ...(quoted.id === 'divRplyFwdMsg' ? [...page.querySelectorAll('#divRplyFwdMsg ~ *')] : [])];
      // Blank lines left above the quote go with it.
      for (let node = lead && parts.includes(lead) ? lead.previousSibling : quoted.previousSibling; node && (node.nodeName === 'BR' || (node.nodeType === 3 && !node.textContent?.trim())); node = node.previousSibling) if (node.nodeName === 'BR') parts.push(node as Element);
      for (const part of parts) part.setAttribute('data-trim', '');
      if ((page.body.innerText || '').trim()) setTrimmed(true); else for (const part of parts) part.removeAttribute('data-trim');
    }
    const measure = () => {
      let bottom = page.body.getBoundingClientRect().height;
      for (const child of page.body.children) bottom = Math.max(bottom, child.getBoundingClientRect().bottom + (page.defaultView?.scrollY || 0));
      setHeight(Math.min(20_000, Math.max(24, Math.ceil(bottom))));
    };
    measure();
    new ResizeObserver(measure).observe(page.body);
    // Pictures arrive after the first measure.
    for (const image of page.images) if (!image.complete) image.addEventListener('load', measure, { once: true });
  }, [darkNow]);
  useEffect(() => { frame.current?.contentDocument?.body?.toggleAttribute('data-all', all); }, [all]);
  // In the dark scheme a plain message is shown with its colours inverted (pictures kept as they are), so it is never a white box on a dark page.
  useEffect(() => onSchemeChange(() => { frame.current?.contentDocument?.documentElement?.toggleAttribute('data-dark', darkNow()); }), [darkNow]);
  const more = <button type="button" className={styles.trim} aria-expanded={all} aria-label={all ? 'Hide trimmed content' : 'Show trimmed content'} title={all ? 'Hide trimmed content' : 'Show trimmed content'} onClick={() => setAll(!all)}><DotsThreeIcon size={18} weight="bold" /></button>;
  if (!message.html) {
    const cut = message.body.search(/\n(?:On [^\n]{5,200} wrote:\s*\n)?(?:>[^\n]*(?:\n|$))+\s*$/), shown = cut > 0 && !all ? message.body.slice(0, cut) : message.body;
    return <div className={styles.text}>{shown.split(/(https?:\/\/[^\s<>"')]+)/g).map((part, index) => index % 2 ? <a key={index} href={part} target="_blank" rel="noopener noreferrer">{part}</a> : part)}{cut > 0 && more}</div>;
  }
  return <><div className={`${styles.paper} ${designed ? styles.designed : ''}`}><iframe ref={frame} title={message.subject} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={source} style={{ height }} onLoad={fit} /></div>{trimmed && more}</>;
}

function Compose({ draft, from, url, onClose, onSend, onError }: { draft: Draft; from: string; url: MailUrl; onClose: (changed: boolean, note?: string) => void; onSend: (request: Promise<unknown>, again: Draft) => void; onError: (message: string) => void }) {
  const [fields, setFields] = useState({ to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject }), [extra, setExtra] = useState(Boolean(draft.cc || draft.bcc));
  const [files, setFiles] = useState<File[]>(draft.files ?? []), [small, setSmall] = useState(false), [busy, setBusy] = useState(false), [saved, setSaved] = useState(''), [quoteShown, setQuoteShown] = useState(false);
  const editor = useRef<HTMLDivElement>(null), picker = useRef<HTMLInputElement>(null), id = useRef(draft.id), dirty = useRef(false), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The latest fields and body are kept outside the DOM so a draft can still be saved while the window is closing.
  const latest = useRef(fields), body = useRef({ html: draft.html, text: '' });
  latest.current = fields;
  const snap = () => { if (editor.current) body.current = { html: editor.current.innerHTML, text: (editor.current.innerText || '').trim() }; };
  const save = useCallback(async () => {
    if (!dirty.current) return;
    dirty.current = false;
    try { const result = await api<{ id: string }>(url('/draft'), { method: 'PUT', body: { id: id.current, replyTo: draft.replyTo, ...latest.current, ...body.current } }); id.current = result.id; setSaved('Draft saved'); }
    catch { dirty.current = true; setSaved('Draft not saved'); }
  }, [draft.replyTo, url]);
  useEffect(() => {
    if (editor.current) { editor.current.innerHTML = draft.html; snap(); if (draft.to) { editor.current.focus(); window.getSelection()?.collapse(editor.current, 0); } }
    return () => { if (timer.current) clearTimeout(timer.current); void save(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const touch = () => { snap(); dirty.current = true; setSaved(''); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { void save(); }, 1500); };
  const set = (key: keyof typeof fields, value: string) => { setFields(current => ({ ...current, [key]: value })); latest.current = { ...latest.current, [key]: value }; touch(); };
  const format = (command: string, value?: string) => { editor.current?.focus(); document.execCommand(command, false, value); touch(); };
  const close = async () => { if (timer.current) clearTimeout(timer.current); const changed = dirty.current || Boolean(id.current); await save(); onClose(changed, changed ? 'Draft saved.' : undefined); };
  const discard = () => {
    if (timer.current) clearTimeout(timer.current);
    dirty.current = false;
    if (id.current) void api(url(''), { method: 'PATCH', body: { action: 'discard', id: id.current } }).catch(() => undefined);
    onClose(Boolean(id.current), 'Draft discarded.');
  };
  const send = async () => {
    if (busy) return;
    snap();
    const message = { ...latest.current, ...body.current };
    if (!message.to.trim() && !message.cc.trim() && !message.bcc.trim()) { onError('Add at least one recipient.'); return; }
    setBusy(true); if (timer.current) clearTimeout(timer.current);
    try {
      const attached = await Promise.all(files.map(async file => { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (let at = 0; at < bytes.length; at += 32768) binary += String.fromCharCode(...bytes.subarray(at, at + 32768)); return { name: file.name, type: file.type, data: btoa(binary) }; }));
      dirty.current = false; onError('');
      // The window closes while the message goes out; if sending fails the page reopens it with everything in it.
      onSend(api(url('/send'), { method: 'POST', body: { ...message, html: `<div style="font:14px/1.55 Arial,Helvetica,sans-serif">${message.html}</div>`, replyTo: draft.replyTo, draft: id.current, files: attached } }),
        { id: id.current, to: message.to, cc: message.cc, bcc: message.bcc, subject: message.subject, html: message.html, replyTo: draft.replyTo, files });
    } catch { onError('An attachment could not be read.'); setBusy(false); }
  };
  const tools: [string, Icon, () => void][] = [['Bold', TextBIcon, () => format('bold')], ['Italic', TextItalicIcon, () => format('italic')], ['Underline', TextUnderlineIcon, () => format('underline')],
    ['Bulleted list', ListBulletsIcon, () => format('insertUnorderedList')], ['Numbered list', ListNumbersIcon, () => format('insertOrderedList')],
    ['Insert link', LinkIcon, () => { const link = window.prompt('Link address'); if (link && /^(https?:|mailto:)/i.test(link)) format('createLink', link); }]];
  return <section className={`${draft.inline ? styles.inline : styles.compose} ${small ? styles.small : ''}`} aria-label={draft.inline ? 'Reply' : 'New message'}
    onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void send(); } }}>
    {!draft.inline && <header onClick={() => small && setSmall(false)}>
      <strong>{fields.subject.trim() || 'New Message'}</strong>
      <Tool label={small ? 'Expand' : 'Minimize'} icon={MinusIcon} onClick={() => setSmall(!small)} />
      <Tool label="Save and close" icon={XIcon} onClick={() => { void close(); }} />
    </header>}
    <div className={styles.composeBody} hidden={small}>
      <label className={styles.field}><span>To</span><input value={fields.to} onChange={event => set('to', event.target.value)} autoFocus={!draft.to} spellCheck={false} autoComplete="off" />{!extra && <button type="button" onClick={() => setExtra(true)}>Cc Bcc</button>}</label>
      {extra && <><label className={styles.field}><span>Cc</span><input value={fields.cc} onChange={event => set('cc', event.target.value)} spellCheck={false} autoComplete="off" /></label>
        <label className={styles.field}><span>Bcc</span><input value={fields.bcc} onChange={event => set('bcc', event.target.value)} spellCheck={false} autoComplete="off" /></label></>}
      {!draft.inline && <label className={styles.field}><input value={fields.subject} placeholder="Subject" aria-label="Subject" onChange={event => set('subject', event.target.value)} /></label>}
      <div ref={editor} className={styles.editor} data-all={quoteShown || undefined} contentEditable role="textbox" aria-multiline="true" aria-label="Message" onInput={touch} suppressContentEditableWarning />
      {!quoteShown && draft.html.includes('gmail_quote') && <button type="button" className={`${styles.trim} ${styles.trimIn}`} aria-label="Show trimmed content" title="Show trimmed content" onClick={() => setQuoteShown(true)}><DotsThreeIcon size={18} weight="bold" /></button>}
      {files.length > 0 && <div className={styles.files}>{files.map((file, index) => <span key={`${file.name}-${index}`} className={styles.file}><PaperclipIcon size={14} />{file.name}<small>{size(file.size)}</small>
        <button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles(files.filter((_, at) => at !== index))}><XIcon size={11} /></button></span>)}</div>}
      <footer>
        <button type="button" className={styles.send} disabled={busy} onClick={() => { void send(); }}>{busy ? 'Sending…' : 'Send'}</button>
        <div className={styles.tools}>{tools.map(([label, icon, run]) => <Tool key={label} label={label} icon={icon} onClick={run} />)}<Tool label="Attach files" icon={PaperclipIcon} onClick={() => picker.current?.click()} /></div>
        <input ref={picker} type="file" multiple hidden onChange={event => { setFiles([...files, ...Array.from(event.target.files || [])]); event.target.value = ''; }} />
        <span className={styles.saved}>{saved || `From ${from}`}</span>
        <Tool label="Discard draft" icon={TrashIcon} onClick={discard} />
      </footer>
    </div>
  </section>;
}

export function Mail({ session, box, onBox, onCounts }: { session: Session; box: MailboxInfo; onBox: (id: string) => void; onCounts: () => void }) {
  const url = useCallback<MailUrl>(path => `/api/mail${path}${path.includes('?') ? '&' : '?'}box=${encodeURIComponent(box.id)}`, [box.id]);
  const [folder, setFolder] = useState<Folder>('inbox'), [query, setQuery] = useState(''), [search, setSearch] = useState(''), [offset, setOffset] = useState(0);
  const { data, error, reload } = useData(() => api<List>(url(`?folder=${folder}&q=${encodeURIComponent(search)}&offset=${offset}`)), [folder, search, offset], 30_000);
  const [checked, setChecked] = useState<string[]>([]), [open, setOpen] = useState(''), [messages, setMessages] = useState<Message[] | null>(null), [wide, setWide] = useState<string[]>([]);
  const [draft, setDraft] = useState<(Draft & { key: number }) | null>(null), [failed, setFailed] = useState(''), [tick, setTick] = useState(0), [slim, setSlim] = useState(false), [drawer, setDrawer] = useState(false);
  const searchBox = useRef<HTMLInputElement>(null);
  // An action shows on screen at once: `ghost` holds what the server hasn't confirmed yet and is dropped when fresh data lands.
  const [ghost, setGhost] = useState<{ gone: string[]; flags: Record<string, Partial<Thread>> }>({ gone: [], flags: {} });
  const [snack, setSnack] = useState<{ key: number; text: string; undo?: () => void } | null>(null);
  const cache = useRef(new Map<string, Message[]>()), warming = useRef(new Set<string>());
  const account = session.account!, many = session.mailboxes.length > 1;
  const say = (text: string, undo?: () => void) => setSnack({ key: Date.now(), text, undo });
  useEffect(() => { if (!snack) return; const timer = setTimeout(() => setSnack(null), snack.undo ? 7000 : 4000); return () => clearTimeout(timer); }, [snack]);
  useEffect(() => { setGhost({ gone: [], flags: {} }); cache.current.clear(); if (many) onCounts(); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const timer = setTimeout(() => { setSearch(query.trim()); setOffset(0); }, 300); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { setChecked([]); }, [folder, search, offset]);
  // A reply written under a conversation closes with it; the compose window saves it as a draft on the way out.
  useEffect(() => { setDraft(current => current?.inline ? null : current); }, [open]);
  useEffect(() => {
    if (!open) { setMessages(null); return; }
    let active = true;
    // A conversation already fetched on hover shows at once; the read below still runs, and is what marks it read.
    const kept = cache.current.get(open);
    if (kept) { setMessages(current => current ?? kept); setWide(current => current.length ? current : kept.slice(-1).map(message => message.id)); }
    api<{ messages: Message[] }>(url(`/thread/${encodeURIComponent(open)}`))
      .then(result => { if (!active) return; setMessages(result.messages); setWide(current => current.length ? current : result.messages.slice(-1).map(message => message.id)); })
      .catch(reason => { if (active) { setFailed(reason instanceof Error ? reason.message : 'Could not open that conversation.'); setOpen(''); } });
    return () => { active = false; };
  }, [open, tick, url]);
  const warm = (id: string) => {
    if (cache.current.has(id) || warming.current.has(id)) return;
    warming.current.add(id);
    api<{ messages: Message[] }>(url(`/thread/${encodeURIComponent(id)}?peek=1`)).then(result => { cache.current.set(id, result.messages); }).catch(() => undefined).finally(() => { warming.current.delete(id); });
  };
  const compose = (next: Draft) => setDraft({ ...next, key: Date.now() });
  const act = async (action: string, ids: string[], undoing = false) => {
    if (!ids.length) return;
    const flag: Partial<Thread> | null = action === 'star' ? { starred: true } : action === 'unstar' ? { starred: false } : action === 'read' ? { unread: false } : action === 'unread' ? { unread: true } : null;
    const leaves = !flag || (action === 'unstar' && folder === 'starred');
    setGhost(now => leaves ? { ...now, gone: [...now.gone, ...ids] } : { ...now, flags: { ...now.flags, ...Object.fromEntries(ids.map(id => [id, { ...now.flags[id], ...flag }])) } });
    setChecked([]);
    if (open && ids.includes(open)) { if (flag && 'starred' in flag) setMessages(list => list && list.map(message => ({ ...message, starred: flag.starred ? 1 : 0 }))); else if (action !== 'read') setOpen(''); }
    try {
      await api(url(''), { method: 'PATCH', body: { action, threads: ids } });
      setFailed('');
      const done = DONE[action], what = folder === 'drafts' && action === 'delete' ? (ids.length > 1 ? `${ids.length} drafts discarded.` : 'Draft discarded.') : done && `${ids.length > 1 ? `${ids.length} conversations` : 'Conversation'} ${done[0]}.`;
      if (undoing) say('Action undone.'); else if (what) say(what, done?.[1] ? () => { void act(done[1]!, ids, true); } : undefined);
    } catch (reason) { setGhost({ gone: [], flags: {} }); setFailed(reason instanceof Error ? reason.message : 'That didn’t work.'); }
    void reload();
  };
  const closed = (changed: boolean, note?: string) => { setDraft(null); if (note) say(note); if (changed) { void reload(); setTick(value => value + 1); } };
  const sent = (request: Promise<unknown>, again: Draft) => {
    setDraft(null); say('Sending…');
    request.then(() => { say('Message sent.'); void reload(); setTick(value => value + 1); })
      .catch(reason => { setSnack(null); setFailed(reason instanceof Error ? reason.message : 'The message was not sent.'); compose(again); });
  };
  const editDraft = (saved: Message) => compose({ id: saved.id, to: saved.recipient, cc: saved.cc, bcc: saved.bcc, subject: saved.subject, html: saved.html || escape(saved.body), replyTo: saved.refs || undefined });
  const choose = async (thread: Thread) => {
    // A lone draft opens straight back into the compose window.
    if (thread.draft && thread.count === 1) {
      try { const result = await api<{ messages: Message[] }>(url(`/thread/${encodeURIComponent(thread.id)}`)), saved = result.messages.find(message => message.id === thread.draft); if (saved) editDraft(saved); }
      catch (reason) { setFailed(reason instanceof Error ? reason.message : 'Could not open that draft.'); }
      return;
    }
    if (thread.unread) setGhost(now => ({ ...now, flags: { ...now.flags, [thread.id]: { ...now.flags[thread.id], unread: false } } }));
    setWide([]); setOpen(thread.id);
  };
  const mine = box.address;
  const reply = (message: Message, mode: 'reply' | 'all' | 'forward') => {
    const others = (list: string) => list.split(',').map(item => item.trim()).filter(item => item && item !== mine && item !== message.sender);
    if (mode === 'forward') compose({ ...BLANK, subject: prefixed('Fwd', message.subject), html: forwarded(message), inline: true });
    else compose({ to: [message.auth === 'sent' ? message.recipient : message.sender, ...(mode === 'all' && message.auth !== 'sent' ? others(message.recipient) : [])].join(', '), cc: mode === 'all' ? others(message.cc).join(', ') : '', bcc: '',
      subject: prefixed('Re', message.subject), html: quote(message), replyTo: message.id, inline: true });
  };
  const last = messages?.filter(message => message.auth !== 'draft').at(-1);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      if (event.key === 'c') { event.preventDefault(); compose(BLANK); }
      else if (event.key === '/') { event.preventDefault(); searchBox.current?.focus(); }
      else if (event.key === 'Escape' && drawer) setDrawer(false);
      else if ((event.key === 'Escape' || event.key === 'u') && open) setOpen('');
      else if (event.key === 'r' && open && last) { event.preventDefault(); reply(last, 'reply'); }
      else if (event.key === 'e' && open && folder === 'inbox') void act('archive', [open]);
      else if (event.key === '#' && open) void act('trash', [open]);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const threads = (data?.threads ?? []).filter(thread => !ghost.gone.includes(thread.id)).map(thread => ghost.flags[thread.id] ? { ...thread, ...ghost.flags[thread.id] } : thread);
  const all = threads.length > 0 && checked.length === threads.length;
  // The unread count moves with what is on screen, ahead of the server's own count.
  const unreadNow = Math.max(0, (data?.counts.inbox ?? 0) + (folder !== 'inbox' ? 0 : threads.filter(thread => thread.unread).length - (data?.threads ?? []).filter(thread => thread.unread).length));
  useEffect(() => { document.title = unreadNow ? `Inbox (${unreadNow}) · ${box.address} · ${product.name}` : `${box.address} · ${product.name}`; }, [unreadNow, box.address]);
  const pick = (id: string) => setChecked(checked.includes(id) ? checked.filter(item => item !== id) : [...checked, id]);
  const go = (next: Folder) => { setFolder(next); setOffset(0); setOpen(''); setDrawer(false); };
  // What can be done to a conversation depends on the folder it is seen in; the same set serves the toolbar and a row's hover.
  const actions = (ids: string[], unread: boolean | null): ReactNode => <>
    {(folder === 'trash' || folder === 'spam' || folder === 'all') && <Tool label="Move to Inbox" icon={TrayArrowDownIcon} onClick={() => { void act('restore', ids); }} />}
    {folder === 'inbox' && <Tool label="Archive" icon={ArchiveIcon} onClick={() => { void act('archive', ids); }} />}
    {!['sent', 'drafts', 'spam', 'trash'].includes(folder) && <Tool label="Report spam" icon={WarningOctagonIcon} onClick={() => { void act('spam', ids); }} />}
    {folder === 'trash' || folder === 'spam' ? <Tool label="Delete forever" icon={TrashIcon} onClick={() => { void act('delete', ids); }} />
      : <Tool label={folder === 'drafts' ? 'Discard draft' : 'Delete'} icon={TrashIcon} onClick={() => { void act(folder === 'drafts' ? 'delete' : 'trash', ids); }} />}
    {folder !== 'drafts' && unread !== true && <Tool label="Mark as unread" icon={EnvelopeSimpleIcon} onClick={() => { void act('unread', ids); }} />}
    {folder !== 'drafts' && unread !== false && <Tool label="Mark as read" icon={EnvelopeOpenIcon} onClick={() => { void act('read', ids); }} />}
  </>;
  const starred = messages?.some(message => message.starred) ?? false;
  const place = !messages ? '' : messages.some(message => message.folder === 'inbox') ? 'Inbox' : messages.every(message => message.folder === 'trash') ? 'Trash' : messages.every(message => message.folder === 'spam') ? 'Spam' : '';
  const toLine = (message: Message) => message.recipient.split(',').map(item => item.trim()).filter(Boolean).map(item => item === mine ? 'me' : item).join(', ') || 'undisclosed recipients';
  const signOut = () => { void api('/api/auth/signout', { method: 'POST' }).finally(() => location.reload()); };
  return <div className={styles.app} data-slim={slim || undefined}>
    <header className={styles.top}>
      <Tool label="Main menu" icon={ListIcon} onClick={() => { if (window.matchMedia('(max-width:820px)').matches) setDrawer(true); else setSlim(!slim); }} />
      <span className={`wordmark ${styles.brand}`}>{product.name}</span>
      <label className={styles.search}><MagnifyingGlassIcon size={20} aria-hidden="true" /><input ref={searchBox} value={query} placeholder={`Search ${many ? box.address : 'mail'}`} aria-label="Search mail" onChange={event => setQuery(event.target.value)} />
        {query && <button type="button" aria-label="Clear search" onClick={() => setQuery('')}><XIcon size={16} /></button>}</label>
      <div className={styles.right}>
        {account.role !== 'member' && <Tool label="People and mailboxes" icon={UsersIcon} onClick={() => navigate('/org')} />}
        <Tool label="Change password" icon={PasswordIcon} onClick={() => navigate('/password')} />
        <Tool label="Sign out" icon={SignOutIcon} onClick={signOut} />
        <span className={styles.me} title={`${account.name} · ${account.address}`} style={{ background: tint(account.address) }}>{initial(account.name || account.address)}</span>
      </div>
    </header>
    {(error || failed) && <div className={styles.error} role="alert">{failed || error}<button type="button" aria-label="Dismiss" onClick={() => setFailed('')}><XIcon size={13} /></button></div>}
    <div className={styles.mail}>
      {drawer && <div className={styles.scrim} onClick={() => setDrawer(false)} />}
      <nav className={`${styles.rail} ${drawer ? styles.shown : ''}`} aria-label="Folders">
        <div className={styles.drawerHead}><span className="wordmark">{product.name}</span></div>
        <button type="button" className={styles.new} onClick={() => { setDrawer(false); compose(BLANK); }}><PencilSimpleIcon size={20} /><span>Compose</span></button>
        {FOLDERS.map(([id, label, FolderIcon]) => { const count = id === 'inbox' ? unreadNow : id === 'drafts' ? data?.counts.drafts : id === 'spam' ? data?.counts.spam : 0;
          return <button type="button" key={id} className={styles.folder} title={label} aria-current={folder === id ? 'true' : undefined} onClick={() => go(id)}>
            <FolderIcon size={20} weight={folder === id ? 'fill' : 'regular'} /><span>{label}</span>{count ? <b data-hot={id === 'inbox' || undefined}>{count}</b> : null}</button>; })}
        {many && <>
          <h3 className={styles.railHead}>Mailboxes</h3>
          {session.mailboxes.map(item => { const count = item.id === box.id ? unreadNow : item.unread;
            return <button type="button" key={item.id} className={styles.folder} title={`${item.name} · ${item.address}`} aria-current={item.id === box.id ? 'true' : undefined} onClick={() => { setDrawer(false); if (item.id !== box.id) onBox(item.id); }}>
              <i className={styles.dot} style={{ background: tint(item.address) }}>{initial(item.name || item.address)}</i><span>{item.kind === 'personal' ? 'My mail' : item.name}<small>{item.address}</small></span>{count ? <b>{count}</b> : null}</button>; })}
        </>}
      </nav>
      <section className={styles.main}>
        {open ? <>
          <div className={styles.bar}><Tool label="Back to list" icon={ArrowLeftIcon} onClick={() => setOpen('')} /><i className={styles.rule} />{actions([open], false)}<span className={styles.gap} />
            <Tool label={starred ? 'Remove star' : 'Star'} icon={StarIcon} on={starred} onClick={() => { void act(starred ? 'unstar' : 'star', [open]); }} /></div>
          {!messages ? <div className={styles.blank}>Loading…</div> : <div className={styles.thread}>
            <h2>{messages[0].subject || '(no subject)'}{place && <span className={styles.chip}>{place}</span>}</h2>
            {messages.map(message => message.auth === 'draft'
              ? <article key={message.id} className={`${styles.card} ${styles.folded}`} onClick={() => editDraft(message)}><span className={styles.face} style={{ background: 'var(--red)' }}><PencilSimpleIcon size={18} /></span>
                  <div className={styles.who}><strong className={styles.draftTag}>Draft</strong><span>{message.body.slice(0, 160) || 'Empty draft'}</span></div><time>{stamp(message.receivedAt)}</time></article>
              : wide.includes(message.id) ? <article key={message.id} className={styles.card}>
                  <span className={styles.face} style={{ background: tint(message.senderName || message.sender) }}>{initial(message.senderName || message.sender)}</span>
                  <div className={styles.head} onClick={() => messages.length > 1 && setWide(wide.filter(id => id !== message.id))}>
                    <div className={styles.who}><strong>{message.senderName || message.sender}{message.senderName && <small>&lt;{message.sender}&gt;</small>}</strong>
                      <span>to {toLine(message)}{message.cc && `, cc: ${message.cc}`}{message.bcc && `, bcc: ${message.bcc}`}{!['pass', 'sent'].includes(message.auth) && <em title="The sending domain did not prove this message is from them."> · unverified sender</em>}</span></div>
                    <time title={new Date(message.receivedAt).toString()}>{stamp(message.receivedAt, true)}</time>
                    <Tool label="Reply" icon={ArrowBendUpLeftIcon} onClick={() => reply(message, 'reply')} />
                  </div>
                  <div className={styles.content}>
                    <MailBody message={message} url={url} />
                    {message.attachments.some(file => !file.cid) && <div className={styles.files}>{message.attachments.map((file, index) => file.cid ? null
                      : <a key={index} className={styles.file} href={url(`/file/${message.id}/${index}`)} target="_blank" rel="noopener noreferrer"><PaperclipIcon size={14} />{file.name}<small>{size(file.size)}</small></a>)}</div>}
                  </div>
                </article>
              : <article key={message.id} className={`${styles.card} ${styles.folded}`} onClick={() => setWide([...wide, message.id])}>
                  <span className={styles.face} style={{ background: tint(message.senderName || message.sender) }}>{initial(message.senderName || message.sender)}</span>
                  <div className={styles.who}><strong>{message.auth === 'sent' ? 'me' : message.senderName || message.sender}</strong><span>{fresh(message.body).slice(0, 200)}</span></div><time>{stamp(message.receivedAt)}</time>
                </article>)}
            {draft?.inline ? <div className={styles.answering}><span className={styles.face} style={{ background: tint(mine) }}>{initial(box.name || mine)}</span>
                <Compose key={draft.key} draft={draft} from={mine} url={url} onError={setFailed} onClose={closed} onSend={sent} /></div>
              : last && <div className={styles.answer}>
                <button type="button" onClick={() => reply(last, 'reply')}><ArrowBendUpLeftIcon size={18} />Reply</button>
                {(last.recipient.includes(',') || last.cc) && <button type="button" onClick={() => reply(last, 'all')}><ArrowBendDoubleUpLeftIcon size={18} />Reply all</button>}
                <button type="button" onClick={() => reply(last, 'forward')}><ArrowBendUpRightIcon size={18} />Forward</button>
              </div>}
          </div>}
        </> : <>
          <div className={styles.bar}>
            <input type="checkbox" className={styles.check} aria-label="Select all" checked={all} ref={input => { if (input) input.indeterminate = checked.length > 0 && !all; }} onChange={() => setChecked(all ? [] : threads.map(thread => thread.id))} />
            {checked.length > 0 ? <>{actions(checked, null)}<span className={styles.count}>{checked.length} selected</span></> : <Tool label="Refresh" icon={ArrowsClockwiseIcon} onClick={() => { void reload(); }} />}
            <span className={styles.gap} />
            {data && data.total > 0 && <span className={styles.count}>{data.offset + 1}–{data.offset + threads.length} of {data.total}</span>}
            <Tool label="Newer" icon={CaretLeftIcon} disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))} />
            <Tool label="Older" icon={CaretRightIcon} disabled={!data || offset + threads.length >= data.total} onClick={() => setOffset(offset + 50)} />
          </div>
          <div className={styles.rows}>
            {!data ? <div className={styles.blank}>{error ? '' : 'Loading…'}</div> : !threads.length ? <div className={styles.blank}><TrayIcon size={56} weight="thin" /><p>{search ? `No messages matched “${search}”.` : folder === 'inbox' ? 'This inbox is empty.' : `No conversations in ${FOLDERS.find(item => item[0] === folder)?.[1]}.`}</p></div>
              : threads.map(thread => { const on = checked.includes(thread.id), lone = Boolean(thread.to && folder !== 'inbox' && thread.count === 1), face = lone ? thread.to! : thread.names.find(name => name !== 'me' && name !== 'Draft') ?? thread.names[0] ?? '?';
                return <div key={thread.id} className={`${styles.row} ${thread.unread ? styles.unread : ''} ${on ? styles.picked : ''}`}>
                  <button type="button" className={styles.face} style={on ? undefined : { background: tint(face) }} aria-label={on ? 'Deselect' : 'Select'} aria-pressed={on} onClick={() => pick(thread.id)}>{on ? <CheckIcon size={20} weight="bold" /> : initial(face)}</button>
                  <input type="checkbox" className={styles.check} aria-label={`Select ${thread.subject}`} checked={on} onChange={() => pick(thread.id)} />
                  <button type="button" className={styles.star} aria-label={thread.starred ? 'Remove star' : 'Star'} aria-pressed={thread.starred} onClick={() => { void act(thread.starred ? 'unstar' : 'star', [thread.id]); }}><StarIcon size={18} weight={thread.starred ? 'fill' : 'regular'} /></button>
                  <button type="button" className={styles.line} onPointerEnter={() => { if (!(thread.draft && thread.count === 1)) warm(thread.id); }} onClick={() => { void choose(thread); }}>
                    <span className={styles.names}>{lone ? <>{thread.draft ? <em>Draft</em> : 'To: '}{thread.draft ? '' : thread.to}</> : thread.names.map((name, index) => name === 'Draft' ? <em key={index}>{index ? ', ' : ''}Draft</em> : `${index ? ', ' : ''}${name}`)}{thread.count > 1 && <small>{thread.count}</small>}</span>
                    <span className={styles.summary}><b>{thread.subject || '(no subject)'}</b><span>{fresh(thread.preview)}</span></span>
                    {thread.files && <PaperclipIcon size={16} className={styles.clip} aria-label="Has attachments" />}
                    <time>{stamp(thread.at)}</time>
                  </button>
                  <div className={styles.quick}>{actions([thread.id], thread.unread)}</div>
                </div>; })}
          </div>
        </>}
      </section>
    </div>
    <button type="button" className={styles.fab} onClick={() => compose(BLANK)}><PencilSimpleIcon size={20} />Compose</button>
    {draft && !draft.inline && <Compose key={draft.key} draft={draft} from={mine} url={url} onError={setFailed} onClose={closed} onSend={sent} />}
    {snack && <div key={snack.key} className={styles.snack} role="status" aria-live="polite"><span>{snack.text}</span>
      {snack.undo && <button type="button" className={styles.undo} onClick={() => { const undo = snack.undo!; setSnack(null); undo(); }}>Undo</button>}
      <button type="button" className={styles.shut} aria-label="Dismiss" onClick={() => setSnack(null)}><XIcon size={16} /></button></div>}
  </div>;
}
