import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Archive as ArchiveIcon,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Clock3,
  Download,
  FileText,
  Inbox,
  LogOut,
  Mail,
  Paperclip,
  Plus,
  RefreshCw,
  Reply,
  RotateCcw,
  Search,
  Send,
  ShieldAlert,
  Trash2,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";

import type { MailFolder, MailRealtimeEvent } from "flary/mail";
import "./styles.css";

type Gate = "loading" | "setup" | "login" | "ready";
type Mailbox = {
  id: string;
  address: string;
  name: string;
  role: string;
  unread: number;
};
type ThreadSummary = {
  id: string;
  subject: string;
  participantsJson: string;
  messageCount: number;
  unreadCount: number;
  lastMessageAt: number;
  lastMessageId: string;
  fromAddress: string;
  fromName?: string;
  snippet: string;
  status: string;
  isRead: number;
  direction: "inbound" | "outbound";
};
type Message = {
  id: string;
  direction: "inbound" | "outbound";
  folder: MailFolder;
  status: string;
  messageId?: string;
  fromAddress: string;
  fromName?: string;
  toJson: string;
  ccJson: string;
  bccJson: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
  isRead: number;
  error?: string;
  createdAt: number;
};
type Attachment = {
  id: string;
  messageId: string;
  filename: string;
  contentType: string;
  size: number;
};
type Member = {
  id: string;
  name: string;
  email: string;
  role: "owner" | "member";
  mailboxes?: string;
};
type ThreadDetail = {
  thread: {
    id: string;
    mailboxId: string;
    subject: string;
    participantsJson: string;
  };
  messages: Message[];
  attachments: Attachment[];
};

const folderLabels: Array<{
  id: MailFolder;
  label: string;
  icon: LucideIcon;
}> = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "sent", label: "Sent", icon: Send },
  { id: "outbox", label: "Outbox", icon: Clock3 },
  { id: "drafts", label: "Drafts", icon: FileText },
  { id: "archive", label: "Archive", icon: ArchiveIcon },
  { id: "spam", label: "Spam", icon: ShieldAlert },
  { id: "trash", label: "Trash", icon: Trash2 },
];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error || "The request failed.");
  return value;
}

function Access({ gate }: { gate: "setup" | "login" }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api(gate === "setup" ? "/api/setup" : "/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          Object.fromEntries(new FormData(event.currentTarget))
        ),
      });
      location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="access">
      <section className="access-card">
        <div className="mail-mark">
          <span>f</span>
          <i />
        </div>
        <p className="eyebrow">Flary Mail</p>
        <h1>{gate === "setup" ? "Open your mailroom" : "Back to the inbox"}</h1>
        <p className="muted">
          {gate === "setup"
            ? "Create the first owner. Registration closes when setup finishes."
            : "Sign in to your Cloudflare-hosted mail."}
        </p>
        <form onSubmit={(event) => void submit(event)}>
          {gate === "setup" ? (
            <>
              <label>
                Setup token
                <input
                  name="token"
                  type="password"
                  required
                  autoComplete="off"
                />
              </label>
              <label>
                Name
                <input name="name" required autoComplete="name" />
              </label>
            </>
          ) : null}
          <label>
            Email
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              minLength={gate === "setup" ? 10 : undefined}
              required
              autoComplete={
                gate === "setup" ? "new-password" : "current-password"
              }
            />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <button className="primary" disabled={busy}>
            {busy ? "Working…" : gate === "setup" ? "Create owner" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}

function Composer({
  mailbox,
  reply,
  draft,
  onClose,
  onSent,
}: {
  mailbox: Mailbox;
  reply?: Message;
  draft?: Message;
  onClose(): void;
  onSent(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function submit(form: HTMLFormElement, saveAsDraft = false) {
    setBusy(true);
    setError(undefined);
    try {
      const data = new FormData(form);
      const files = [
        ...((form.elements.namedItem("attachments") as HTMLInputElement)
          .files ?? []),
      ];
      const attachments = await Promise.all(
        files.map(async (file) => ({
          filename: file.name,
          type: file.type || "application/octet-stream",
          contentBase64: await fileBase64(file),
        }))
      );
      await api("/api/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mailboxId: mailbox.id,
          to: splitAddresses(String(data.get("to") ?? "")),
          cc: splitAddresses(String(data.get("cc") ?? "")),
          bcc: splitAddresses(String(data.get("bcc") ?? "")),
          subject: String(data.get("subject") ?? ""),
          text: String(data.get("text") ?? ""),
          ...(reply && !draft ? { replyToMessageId: reply.id } : {}),
          ...(attachments.length ? { attachments } : {}),
          draft: saveAsDraft,
        }),
      });
      if (draft) {
        await api(`/api/messages/${draft.id}/move`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ folder: "trash" }),
        });
      }
      onSent();
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The message could not be saved."
      );
    } finally {
      setBusy(false);
    }
  }
  const replyTo = reply?.direction === "inbound" ? reply.fromAddress : "";
  const to = draft ? parseAddresses(draft.toJson).join(", ") : replyTo;
  return (
    <div
      className="compose-shade"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="compose"
        role="dialog"
        aria-modal="true"
        aria-label={draft ? "Edit draft" : reply ? "Reply" : "New message"}
      >
        <header>
          <div>
            <p className="eyebrow">{mailbox.address}</p>
            <h2>{draft ? "Edit draft" : reply ? "Reply" : "New message"}</h2>
          </div>
          <button className="icon" onClick={onClose} aria-label="Close">
            <X aria-hidden="true" />
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(event.currentTarget);
          }}
        >
          <label className="line">
            <span>To</span>
            <input name="to" type="text" defaultValue={to} required />
          </label>
          <label className="line">
            <span>Cc</span>
            <input
              name="cc"
              type="text"
              defaultValue={
                draft ? parseAddresses(draft.ccJson).join(", ") : ""
              }
            />
          </label>
          <label className="line">
            <span>Bcc</span>
            <input
              name="bcc"
              type="text"
              defaultValue={
                draft ? parseAddresses(draft.bccJson).join(", ") : ""
              }
            />
          </label>
          <label className="line">
            <span>Subject</span>
            <input
              name="subject"
              type="text"
              defaultValue={
                draft
                  ? draft.subject
                  : reply
                  ? `Re: ${reply.subject.replace(/^re:\s*/i, "")}`
                  : ""
              }
              required
            />
          </label>
          <textarea
            name="text"
            placeholder="Write your message…"
            autoFocus
            required
            defaultValue={draft?.textBody ?? ""}
          />
          <label className="file">
            <span>
              <Paperclip aria-hidden="true" /> Attach files
            </span>
            <input name="attachments" type="file" multiple />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <footer>
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={(event) => void submit(event.currentTarget.form!, true)}
            >
              Save draft
            </button>
            <button className="primary" disabled={busy}>
              {busy ? "Queuing…" : "Send message"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function MemberPanel({
  mailboxes,
  onClose,
}: {
  mailboxes: Mailbox[];
  onClose(): void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [result, setResult] = useState("");
  const loadMembers = useCallback(async () => {
    const value = await api<{ members: Member[] }>("/api/members");
    setMembers(value.members);
  }, []);
  useEffect(() => {
    void loadMembers().catch((cause) =>
      setResult(
        cause instanceof Error ? cause.message : "Members could not be loaded."
      )
    );
  }, [loadMembers]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await api("/api/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: data.get("name"),
          email: data.get("email"),
          password: data.get("password"),
          mailboxIds: data.getAll("mailboxIds"),
        }),
      });
      setResult(
        "Member added. Share the temporary password through a secure channel."
      );
      form.reset();
      await loadMembers();
    } catch (cause) {
      setResult(
        cause instanceof Error
          ? cause.message
          : "The member could not be added."
      );
    }
  }
  return (
    <div className="compose-shade" role="presentation">
      <section className="compose members" role="dialog" aria-modal="true">
        <header>
          <div>
            <p className="eyebrow">Access</p>
            <h2>Add a member</h2>
          </div>
          <button className="icon" onClick={onClose} aria-label="Close">
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="member-list" aria-label="Current members">
          {members.map((member) => (
            <article key={member.id}>
              <div className="avatar small">
                {member.name.slice(0, 1).toUpperCase()}
              </div>
              <div>
                <strong>{member.name}</strong>
                <p>{member.email}</p>
              </div>
              <span>{member.role}</span>
            </article>
          ))}
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            Name
            <input name="name" required />
          </label>
          <label>
            Email
            <input name="email" type="email" required />
          </label>
          <label>
            Temporary password
            <input name="password" type="password" minLength={10} required />
          </label>
          <fieldset>
            <legend>Mailboxes</legend>
            {mailboxes.map((mailbox) => (
              <label className="check" key={mailbox.id}>
                <input
                  name="mailboxIds"
                  value={mailbox.id}
                  type="checkbox"
                  defaultChecked
                />
                {mailbox.address}
              </label>
            ))}
          </fieldset>
          {result ? <p className="muted">{result}</p> : null}
          <footer>
            <button className="primary">Add member</button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function MailApp({
  user,
}: {
  user: { id: string; name: string; email: string; role: string };
}) {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [mailboxId, setMailboxId] = useState("");
  const [folder, setFolder] = useState<MailFolder>("inbox");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string>();
  const [detail, setDetail] = useState<ThreadDetail>();
  const [compose, setCompose] = useState<{
    reply?: Message;
    draft?: Message;
  }>();
  const [members, setMembers] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string>();
  const mailbox = mailboxes.find((item) => item.id === mailboxId);

  const loadMailboxes = useCallback(async () => {
    const value = await api<{ mailboxes: Mailbox[] }>("/api/mailboxes");
    setMailboxes(value.mailboxes);
    setMailboxId((current) => current || value.mailboxes[0]?.id || "");
  }, []);
  const loadThreads = useCallback(async () => {
    if (!mailboxId) return;
    const value = await api<{ threads: ThreadSummary[] }>(
      `/api/threads?mailboxId=${encodeURIComponent(mailboxId)}&folder=${folder}`
    );
    setThreads(value.threads);
    setThreadId((current) =>
      current && value.threads.some((item) => item.id === current)
        ? current
        : window.matchMedia("(min-width: 801px)").matches
        ? value.threads[0]?.id
        : undefined
    );
  }, [mailboxId, folder]);
  const loadDetail = useCallback(async () => {
    if (!threadId) return setDetail(undefined);
    const value = await api<ThreadDetail>(
      `/api/threads/${encodeURIComponent(threadId)}`
    );
    setDetail(value);
    const unread = value.messages.filter(
      (message) => !message.isRead && message.direction === "inbound"
    );
    await Promise.all(
      unread.map((message) =>
        api(`/api/messages/${message.id}/read`, { method: "POST" })
      )
    );
  }, [threadId]);

  useEffect(() => {
    void loadMailboxes().catch((cause) => setError(String(cause)));
  }, [loadMailboxes]);
  useEffect(() => {
    void loadThreads().catch((cause) => setError(String(cause)));
  }, [loadThreads]);
  useEffect(() => {
    void loadDetail().catch((cause) => setError(String(cause)));
  }, [loadDetail]);
  useEffect(() => {
    if (!mailboxId) return;
    let socket: WebSocket | undefined;
    let reconnect: number | undefined;
    let stopped = false;
    const connect = () => {
      const url = new URL("/api/realtime", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("mailboxId", mailboxId);
      socket = new WebSocket(url);
      socket.onmessage = (event) => {
        try {
          const value = JSON.parse(String(event.data)) as MailRealtimeEvent;
          if (value.type === "mail.changed")
            void Promise.all([loadMailboxes(), loadThreads(), loadDetail()]);
        } catch {
          /* Ignore heartbeat data. */
        }
      };
      socket.onclose = () => {
        if (!stopped) reconnect = window.setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (reconnect) clearTimeout(reconnect);
      socket?.close();
    };
  }, [mailboxId, loadDetail, loadMailboxes, loadThreads]);

  const currentIndex = threads.findIndex((item) => item.id === threadId);
  const selectedThread = threads[currentIndex];
  const visibleThreads = useMemo(
    () =>
      threads.filter((thread) => {
        const query = search.trim().toLowerCase();
        if (!query) return true;
        return [
          thread.fromName,
          thread.fromAddress,
          thread.subject,
          thread.snippet,
        ].some((value) => value?.toLowerCase().includes(query));
      }),
    [search, threads]
  );

  async function move(messageId: string, destination: MailFolder) {
    await api(`/api/messages/${messageId}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: destination }),
    });
    await loadThreads();
  }

  async function signOut() {
    await api("/api/auth/sign-out", { method: "POST" });
    location.reload();
  }

  return (
    <main className="mail-shell">
      <aside className="rail">
        <a className="brand" href="/" aria-label="Flary Mail">
          <span>f</span>
          <b>Flary</b>
          <small>mail</small>
        </a>
        <button
          className="compose-button"
          onClick={() => setCompose({})}
          aria-label="Compose message"
        >
          <Plus aria-hidden="true" /> <span>Compose</span>
        </button>
        <nav>
          {folderLabels.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={folder === item.id ? "active" : ""}
                title={item.label}
                onClick={() => {
                  setFolder(item.id);
                  setThreadId(undefined);
                }}
              >
                <i>
                  <Icon aria-hidden="true" />
                </i>
                <span>{item.label}</span>
                {item.id === "inbox" && mailbox?.unread ? (
                  <em>{mailbox.unread}</em>
                ) : null}
              </button>
            );
          })}
        </nav>
        <footer>
          {user.role === "owner" ? (
            <button onClick={() => setMembers(true)} title="Manage team">
              <Users aria-hidden="true" /> <span>Team</span>
            </button>
          ) : null}
          <button onClick={() => void signOut()} title="Sign out">
            <LogOut aria-hidden="true" /> <span>Sign out</span>
          </button>
          <div className="avatar">{user.name.slice(0, 1).toUpperCase()}</div>
        </footer>
      </aside>
      <section className="list-pane">
        <header>
          <div>
            <p className="eyebrow">Mailbox</p>
            <div className="mailbox-picker">
              <Mail aria-hidden="true" />
              <select
                value={mailboxId}
                onChange={(event) => setMailboxId(event.target.value)}
              >
                {mailboxes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.address}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button
            className="icon"
            onClick={() => void loadThreads()}
            aria-label="Refresh"
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </header>
        <label className="search">
          <Search aria-hidden="true" />
          <span className="sr-only">Search this folder</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search this folder"
          />
        </label>
        <div className="list-title">
          <h1>{folderLabels.find((item) => item.id === folder)?.label}</h1>
          <span>{threads.length}</span>
        </div>
        <div className="thread-list">
          {visibleThreads.length ? (
            visibleThreads.map((thread) => (
              <button
                key={thread.id}
                className={thread.id === threadId ? "selected" : ""}
                onClick={() => setThreadId(thread.id)}
              >
                <span className={`dot ${thread.isRead ? "read" : ""}`} />
                <div>
                  <strong>{thread.fromName || thread.fromAddress}</strong>
                  <time>{formatTime(thread.lastMessageAt)}</time>
                  <b>{thread.subject || "(no subject)"}</b>
                  <p>{thread.snippet || thread.status}</p>
                </div>
              </button>
            ))
          ) : (
            <div className="empty">
              <span>⌁</span>
              <h2>No mail here</h2>
              <p>
                {search
                  ? "No messages match this search."
                  : folder === "inbox"
                  ? `Messages sent to ${
                      mailbox?.address ?? "this mailbox"
                    } will arrive here.`
                  : `The ${folder} folder is clear.`}
              </p>
            </div>
          )}
        </div>
      </section>
      <section className="message-pane">
        {detail && selectedThread ? (
          <>
            <header className="message-head">
              <button
                className="mobile-back"
                onClick={() => setThreadId(undefined)}
                aria-label="Back to message list"
              >
                <ArrowLeft aria-hidden="true" />
              </button>
              <div>
                <p className="eyebrow">
                  {detail.messages.length} message
                  {detail.messages.length === 1 ? "" : "s"}
                </p>
                <h1>{detail.thread.subject}</h1>
              </div>
              <div className="message-actions">
                <button
                  onClick={() => setThreadId(threads[currentIndex - 1]?.id)}
                  disabled={currentIndex <= 0}
                  aria-label="Previous conversation"
                >
                  <ArrowUp aria-hidden="true" />
                </button>
                <button
                  onClick={() => setThreadId(threads[currentIndex + 1]?.id)}
                  disabled={
                    currentIndex < 0 || currentIndex >= threads.length - 1
                  }
                  aria-label="Next conversation"
                >
                  <ArrowDown aria-hidden="true" />
                </button>
              </div>
            </header>
            <div className="conversation">
              {detail.messages.map((message) => (
                <article key={message.id} className={message.direction}>
                  <header>
                    <div className="avatar small">
                      {(message.fromName || message.fromAddress)
                        .slice(0, 1)
                        .toUpperCase()}
                    </div>
                    <div>
                      <strong>{message.fromName || message.fromAddress}</strong>
                      <p>to {parseAddresses(message.toJson).join(", ")}</p>
                    </div>
                    <time>{new Date(message.createdAt).toLocaleString()}</time>
                  </header>
                  <div className="body">
                    {message.textBody || "(No text body)"}
                  </div>
                  {detail.attachments.filter(
                    (item) => item.messageId === message.id
                  ).length ? (
                    <div className="attachments">
                      {detail.attachments
                        .filter((item) => item.messageId === message.id)
                        .map((item) => (
                          <a key={item.id} href={`/api/attachments/${item.id}`}>
                            <Download aria-hidden="true" /> {item.filename}
                            <small>{formatSize(item.size)}</small>
                          </a>
                        ))}
                    </div>
                  ) : null}
                  {message.error ? (
                    <p className="delivery-error">{message.error}</p>
                  ) : null}
                  <footer>
                    <span className={`status ${message.status}`}>
                      {message.status}
                    </span>
                    {message.status === "draft" ? (
                      <button onClick={() => setCompose({ draft: message })}>
                        <FileText aria-hidden="true" /> Edit draft
                      </button>
                    ) : (
                      <button onClick={() => setCompose({ reply: message })}>
                        <Reply aria-hidden="true" /> Reply
                      </button>
                    )}
                    <button
                      onClick={() =>
                        void move(
                          message.id,
                          folder === "trash" ? "inbox" : "archive"
                        )
                      }
                    >
                      {folder === "trash" ? (
                        <>
                          <RotateCcw aria-hidden="true" /> Restore
                        </>
                      ) : (
                        <>
                          <ArchiveIcon aria-hidden="true" /> Archive
                        </>
                      )}
                    </button>
                    <button onClick={() => void move(message.id, "trash")}>
                      <Trash2 aria-hidden="true" /> Trash
                    </button>
                  </footer>
                </article>
              ))}
            </div>
            {detail.messages.at(-1)?.status === "draft" ? (
              <button
                className="reply-bar"
                onClick={() => setCompose({ draft: detail.messages.at(-1) })}
              >
                <FileText aria-hidden="true" /> Edit this draft
              </button>
            ) : (
              <button
                className="reply-bar"
                onClick={() => setCompose({ reply: detail.messages.at(-1) })}
              >
                <Reply aria-hidden="true" /> Reply to this conversation
              </button>
            )}
          </>
        ) : (
          <div className="message-empty">
            <div className="route-line" />
            <p className="eyebrow">Flary Mail</p>
            <h1>Your project has a mailroom.</h1>
            <p>
              Choose a conversation or write a new message from{" "}
              {mailbox?.address}.
            </p>
            <button className="primary" onClick={() => setCompose({})}>
              Compose message
            </button>
          </div>
        )}
      </section>
      {compose && mailbox ? (
        <Composer
          mailbox={mailbox}
          reply={compose.reply}
          draft={compose.draft}
          onClose={() => setCompose(undefined)}
          onSent={() => void Promise.all([loadThreads(), loadDetail()])}
        />
      ) : null}
      {members && user.role === "owner" ? (
        <MemberPanel mailboxes={mailboxes} onClose={() => setMembers(false)} />
      ) : null}
      {error ? (
        <button className="toast" onClick={() => setError(undefined)}>
          {error} ×
        </button>
      ) : null}
    </main>
  );
}

function Root() {
  const [gate, setGate] = useState<Gate>("loading");
  const [user, setUser] = useState<{
    id: string;
    name: string;
    email: string;
    role: string;
  }>();
  useEffect(() => {
    void (async () => {
      const setup = await api<{ open: boolean }>("/api/setup/status");
      if (setup.open) return setGate("setup");
      try {
        const session = await api<{ user: typeof user }>("/api/session");
        setUser(session.user);
        setGate("ready");
      } catch {
        setGate("login");
      }
    })();
  }, []);
  if (gate === "loading")
    return (
      <div className="boot">
        <div className="mail-mark">
          <span>f</span>
          <i />
        </div>
        <p>Opening Flary Mail</p>
      </div>
    );
  if (gate === "setup" || gate === "login") return <Access gate={gate} />;
  return user ? <MailApp user={user} /> : null;
}

function splitAddresses(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
function parseAddresses(value: string): string[] {
  try {
    const result: unknown = JSON.parse(value);
    return Array.isArray(result)
      ? result.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
function formatTime(value: number): string {
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}
function formatSize(value: number): string {
  return value < 1024 * 1024
    ? `${Math.ceil(value / 1024)} KB`
    : `${(value / 1024 / 1024).toFixed(1)} MB`;
}
function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
