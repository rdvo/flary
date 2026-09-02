import { Hono } from "hono";
import { z } from "zod";

import { createAuth } from "./auth";
import {
  broadcast,
  composeMessage,
  failOutbound,
  processDeliveryEvent,
  processInbound,
  provisionConfiguredMailboxes,
  receiveEmail,
  sendOutbound,
  type MailQueueJob,
} from "./mail";
import { MailRoom } from "./mail-room";

export { MailRoom };

type UserContext = {
  id: string;
  email: string;
  name: string;
  role: "owner" | "member";
};

const app = new Hono<{ Bindings: Env }>();
const folders = ["inbox", "sent", "outbox", "drafts", "archive", "spam", "trash"] as const;
const FolderSchema = z.enum(folders);
const AddressListSchema = z.array(z.string().email()).max(50).default([]);
const ComposeSchema = z.object({
  mailboxId: z.string().min(1),
  to: AddressListSchema,
  cc: AddressListSchema.optional(),
  bcc: AddressListSchema.optional(),
  subject: z.string().max(998).default(""),
  text: z.string().max(2_000_000).default(""),
  html: z.string().max(2_000_000).optional(),
  replyToMessageId: z.string().uuid().optional(),
  draft: z.boolean().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1).max(255),
        type: z.string().min(1).max(255),
        contentBase64: z.string().max(6_000_000),
      }),
    )
    .max(20)
    .optional(),
});

app.get("/health", (context) => context.json({ ok: true, service: "flary-mail" }));

app.on(["GET", "POST"], "/api/auth/*", (context) =>
  createAuth(context.env, new URL(context.req.url).origin).handler(context.req.raw),
);

app.get("/api/setup/status", async (context) => {
  const installation = await context.env.MAIL_DB.prepare(
    "SELECT status FROM mail_installation WHERE id = 'owner'",
  ).first<{ status: string }>();
  return context.json({
    open: installation?.status !== "ready",
    status: installation?.status ?? "new",
  });
});

app.post("/api/setup", async (context) => {
  const input = z
    .object({
      token: z.string().min(1),
      name: z.string().min(1).max(100),
      email: z.string().email(),
      password: z.string().min(10).max(200),
    })
    .parse(await context.req.json());
  if (!(await constantTimeEqual(input.token, context.env.FLARY_SETUP_TOKEN))) {
    return context.json({ error: "The setup token is invalid." }, 401);
  }
  const current = await context.env.MAIL_DB.prepare(
    "SELECT status FROM mail_installation WHERE id = 'owner'",
  ).first<{ status: string }>();
  if (current?.status === "ready") return context.json({ error: "Setup is closed." }, 409);
  const lock = await context.env.MAIL_DB.prepare(
    `
    INSERT OR IGNORE INTO mail_installation (id, status, created_at)
    VALUES ('owner', 'initializing', ?)
  `,
  )
    .bind(Date.now())
    .run();
  if (!lock.meta.changes) return context.json({ error: "Owner setup is already running." }, 409);

  try {
    const created = await createAuth(context.env, new URL(context.req.url).origin).api.signUpEmail({
      body: { name: input.name, email: input.email, password: input.password },
    });
    const mailboxes = await provisionConfiguredMailboxes(context.env);
    await context.env.MAIL_DB.batch([
      context.env.MAIL_DB.prepare(
        "INSERT INTO mail_member (user_id, role) VALUES (?, 'owner')",
      ).bind(created.user.id),
      ...mailboxes.map((mailbox) =>
        context.env.MAIL_DB.prepare(
          `
        INSERT INTO mailbox_member (mailbox_id, user_id, role) VALUES (?, ?, 'manager')
      `,
        ).bind(mailbox.id, created.user.id),
      ),
      context.env.MAIL_DB.prepare(
        `
        UPDATE mail_installation SET status = 'ready', owner_user_id = ?, initialized_at = ?
        WHERE id = 'owner' AND status = 'initializing'
      `,
      ).bind(created.user.id, Date.now()),
    ]);
    return context.json({ ok: true, owner: created.user.email, mailboxes });
  } catch (error) {
    await context.env.MAIL_DB.prepare(
      "DELETE FROM mail_installation WHERE id = 'owner' AND status = 'initializing'",
    ).run();
    throw error;
  }
});

app.get("/api/session", async (context) => {
  const user = await requireUser(context.env, context.req.raw);
  return context.json({ user });
});

app.get("/api/mailboxes", async (context) => {
  const user = await requireUser(context.env, context.req.raw);
  const result = await context.env.MAIL_DB.prepare(
    `
    SELECT mb.id, mb.address, mb.name, mm.role,
      (SELECT COUNT(*) FROM mail_message msg WHERE msg.mailbox_id = mb.id AND msg.folder = 'inbox' AND msg.is_read = 0) AS unread
    FROM mailbox mb JOIN mailbox_member mm ON mm.mailbox_id = mb.id
    WHERE mm.user_id = ? ORDER BY mb.address
  `,
  )
    .bind(user.id)
    .all<{
      id: string;
      address: string;
      name: string;
      role: string;
      unread: number;
    }>();
  return context.json({ mailboxes: result.results });
});

app.get("/api/threads", async (context) => {
  const user = await requireUser(context.env, context.req.raw);
  const mailboxId = requiredQuery(context.req.query("mailboxId"), "mailboxId");
  const folder = FolderSchema.parse(context.req.query("folder") ?? "inbox");
  await requireMailbox(context.env, user.id, mailboxId);
  const result = await context.env.MAIL_DB.prepare(
    `
    SELECT t.id, t.subject, t.participants_json AS participantsJson,
           t.message_count AS messageCount, t.unread_count AS unreadCount,
           t.last_message_at AS lastMessageAt,
           m.id AS lastMessageId, m.from_address AS fromAddress,
           m.from_name AS fromName, m.text_body AS snippet, m.status,
           m.is_read AS isRead, m.direction
    FROM mail_thread t
    JOIN mail_message m ON m.id = (
      SELECT candidate.id FROM mail_message candidate
      WHERE candidate.thread_id = t.id AND candidate.folder = ?
      ORDER BY candidate.created_at DESC LIMIT 1
    )
    WHERE t.mailbox_id = ?
    ORDER BY m.created_at DESC LIMIT 100
  `,
  )
    .bind(folder, mailboxId)
    .all<Record<string, unknown>>();
  return context.json({ threads: result.results });
});

app.get("/api/threads/:threadId", async (context) => {
  const user = await requireUser(context.env, context.req.raw);
  const thread = await context.env.MAIL_DB.prepare(
    `
    SELECT id, mailbox_id AS mailboxId, subject, participants_json AS participantsJson
    FROM mail_thread WHERE id = ?
  `,
  )
    .bind(context.req.param("threadId"))
    .first<{
      id: string;
      mailboxId: string;
      subject: string;
      participantsJson: string;
    }>();
  if (!thread) return context.json({ error: "Thread not found." }, 404);
  await requireMailbox(context.env, user.id, thread.mailboxId);
  const messages = await context.env.MAIL_DB.prepare(
    `
    SELECT id, direction, folder, status, message_id AS messageId,
      in_reply_to AS inReplyTo, from_address AS fromAddress, from_name AS fromName,
      to_json AS toJson, cc_json AS ccJson, bcc_json AS bccJson,
      subject, text_body AS textBody, html_body AS htmlBody,
      is_read AS isRead, error, sent_at AS sentAt, delivered_at AS deliveredAt,
      created_at AS createdAt
    FROM mail_message WHERE thread_id = ? ORDER BY created_at
  `,
  )
    .bind(thread.id)
    .all<Record<string, unknown>>();
  const attachments = await context.env.MAIL_DB.prepare(
    `
    SELECT a.id, a.message_id AS messageId, a.filename, a.content_type AS contentType,
      a.size, a.content_id AS contentId, a.disposition
    FROM mail_attachment a JOIN mail_message m ON m.id = a.message_id
    WHERE m.thread_id = ? ORDER BY a.created_at
  `,
  )
    .bind(thread.id)
    .all<Record<string, unknown>>();
  return context.json({
    thread,
    messages: messages.results,
    attachments: attachments.results,
  });
});

app.post("/api/messages", async (context) => {
  const user = await requireUser(context.env, context.req.raw);
  const length = Number(context.req.header("content-length") ?? 0);
  if (length > 7 * 1024 * 1024)
    return context.json({ error: "The message upload is too large." }, 413);
  const input = ComposeSchema.parse(await context.req.json());
  await requireMailbox(context.env, user.id, input.mailboxId);
  const message = await composeMessage(context.env, user.id, input);
  return context.json({ message }, input.draft ? 201 : 202);
});

app.post("/api/messages/:messageId/read", async (context) => {
  const user = await requireUser(context.env, context.req.raw);
  const message = await requireMessage(context.env, user.id, context.req.param("messageId"));
  await context.env.MAIL_DB.batch([
    context.env.MAIL_DB.prepare(
      "UPDATE mail_message SET is_read = 1, updated_at = ? WHERE id = ?",
    ).bind(Date.now(), message.id),
    context.env.MAIL_DB.prepare(
      `
      UPDATE mail_thread SET unread_count = (
        SELECT COUNT(*) FROM mail_message WHERE thread_id = ? AND is_read = 0 AND direction = 'inbound'
      ), updated_at = ? WHERE id = ?
    `,
    ).bind(message.threadId, Date.now(), message.threadId),
  ]);
  await broadcast(context.env, message.mailboxId, message.id, "read");
  return context.json({ ok: true });
});

app.post("/api/messages/:messageId/move", async (context) => {
  const user = await requireUser(context.env, context.req.raw);
  const message = await requireMessage(context.env, user.id, context.req.param("messageId"));
  const { folder } = z.object({ folder: FolderSchema }).parse(await context.req.json());
  await context.env.MAIL_DB.prepare(
    "UPDATE mail_message SET folder = ?, updated_at = ? WHERE id = ?",
  )
    .bind(folder, Date.now(), message.id)
    .run();
  await broadcast(context.env, message.mailboxId, message.id, "moved");
  return context.json({ ok: true });
});

app.get("/api/attachments/:attachmentId", async (context) => {
  const user = await requireUser(context.env, context.req.raw);
  const attachment = await context.env.MAIL_DB.prepare(
    `
    SELECT a.object_key AS objectKey, a.filename, a.content_type AS contentType
    FROM mail_attachment a
    JOIN mail_message m ON m.id = a.message_id
    JOIN mailbox_member mm ON mm.mailbox_id = m.mailbox_id
    WHERE a.id = ? AND mm.user_id = ?
  `,
  )
    .bind(context.req.param("attachmentId"), user.id)
    .first<{
      objectKey: string;
      filename: string;
      contentType: string;
    }>();
  if (!attachment) return context.json({ error: "Attachment not found." }, 404);
  const object = await context.env.MAIL_STORAGE.get(attachment.objectKey);
  if (!object) return context.json({ error: "Attachment data is missing." }, 404);
  return new Response(object.body, {
    headers: {
      "content-type": attachment.contentType,
      "content-length": String(object.size),
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(
        attachment.filename,
      )}`,
      "cache-control": "private, no-store",
    },
  });
});

app.get("/api/realtime", async (context) => {
  const user = await requireUser(context.env, context.req.raw);
  const mailboxId = requiredQuery(context.req.query("mailboxId"), "mailboxId");
  await requireMailbox(context.env, user.id, mailboxId);
  if (context.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return context.text("Expected a WebSocket upgrade.", 426);
  }
  const headers = new Headers(context.req.raw.headers);
  headers.set("x-flary-mail-user", user.id);
  headers.set("x-flary-mail-mailbox", mailboxId);
  return context.env.MAIL_ROOM.getByName(mailboxId).fetch(
    new Request(context.req.url, { headers }),
  );
});

app.get("/api/members", async (context) => {
  const user = await requireOwner(context.env, context.req.raw);
  const members = await context.env.MAIL_DB.prepare(
    `
    SELECT u.id, u.name, u.email, mm.role, GROUP_CONCAT(mb.address) AS mailboxes
    FROM user u JOIN mail_member mm ON mm.user_id = u.id
    LEFT JOIN mailbox_member access ON access.user_id = u.id
    LEFT JOIN mailbox mb ON mb.id = access.mailbox_id
    GROUP BY u.id, u.name, u.email, mm.role ORDER BY u.created_at
  `,
  ).all<Record<string, unknown>>();
  return context.json({ owner: user.id, members: members.results });
});

app.post("/api/members", async (context) => {
  await requireOwner(context.env, context.req.raw);
  const input = z
    .object({
      name: z.string().min(1).max(100),
      email: z.string().email(),
      password: z.string().min(10).max(200),
      mailboxIds: z.array(z.string().min(1)).min(1),
    })
    .parse(await context.req.json());
  const created = await createAuth(context.env, new URL(context.req.url).origin).api.signUpEmail({
    body: { name: input.name, email: input.email, password: input.password },
  });
  await context.env.MAIL_DB.batch([
    context.env.MAIL_DB.prepare(
      "INSERT INTO mail_member (user_id, role) VALUES (?, 'member')",
    ).bind(created.user.id),
    ...input.mailboxIds.map((mailboxId) =>
      context.env.MAIL_DB.prepare(
        `
      INSERT INTO mailbox_member (mailbox_id, user_id, role)
      SELECT id, ?, 'member' FROM mailbox WHERE id = ?
    `,
      ).bind(created.user.id, mailboxId),
    ),
  ]);
  return context.json(
    {
      member: {
        id: created.user.id,
        name: created.user.name,
        email: created.user.email,
      },
    },
    201,
  );
});

app.notFound((context) => context.json({ error: "Not found." }, 404));
app.onError((error, context) => {
  console.error(
    JSON.stringify({
      level: "error",
      message: "mail request failed",
      path: new URL(context.req.url).pathname,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  if (error instanceof z.ZodError)
    return context.json({ error: "The request data is invalid.", details: error.issues }, 400);
  if (error instanceof ResponseError) return context.json({ error: error.message }, error.status);
  return context.json({ error: "The mail request failed." }, 500);
});

const worker = {
  fetch: app.fetch,
  email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    return receiveEmail(message, env);
  },
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const item of batch.messages) {
      try {
        if (await processDeliveryEvent(env, item.body)) {
          item.ack();
          continue;
        }
        const job = parseQueueJob(item.body);
        if (job.type === "parse-inbound") await processInbound(env, job.messageId);
        else await sendOutbound(env, job.messageId);
        item.ack();
      } catch (error) {
        const job = safeQueueJob(item.body);
        if (item.attempts >= 5 && job?.type === "send-outbound") {
          await failOutbound(
            env,
            job.messageId,
            error instanceof Error ? error.message : "Email sending failed.",
          );
          item.ack();
        } else {
          item.retry();
        }
      }
    }
  },
} satisfies ExportedHandler<Env>;

export default worker;

async function requireUser(env: Env, request: Request): Promise<UserContext> {
  const session = await createAuth(env, new URL(request.url).origin).api.getSession({
    headers: request.headers,
  });
  if (!session?.user) throw new ResponseError(401, "Authentication is required.");
  const member = await env.MAIL_DB.prepare("SELECT role FROM mail_member WHERE user_id = ?")
    .bind(session.user.id)
    .first<{ role: "owner" | "member" }>();
  if (!member) throw new ResponseError(403, "This account is not a mail member.");
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: member.role,
  };
}

async function requireOwner(env: Env, request: Request): Promise<UserContext> {
  const user = await requireUser(env, request);
  if (user.role !== "owner") throw new ResponseError(403, "Owner access is required.");
  return user;
}

async function requireMailbox(env: Env, userId: string, mailboxId: string): Promise<void> {
  const access = await env.MAIL_DB.prepare(
    "SELECT 1 AS allowed FROM mailbox_member WHERE mailbox_id = ? AND user_id = ?",
  )
    .bind(mailboxId, userId)
    .first<{ allowed: number }>();
  if (!access) throw new ResponseError(403, "Mailbox access is required.");
}

async function requireMessage(
  env: Env,
  userId: string,
  messageId: string,
): Promise<{ id: string; mailboxId: string; threadId: string }> {
  const message = await env.MAIL_DB.prepare(
    `
    SELECT m.id, m.mailbox_id AS mailboxId, m.thread_id AS threadId
    FROM mail_message m JOIN mailbox_member mm ON mm.mailbox_id = m.mailbox_id
    WHERE m.id = ? AND mm.user_id = ?
  `,
  )
    .bind(messageId, userId)
    .first<{ id: string; mailboxId: string; threadId: string }>();
  if (!message) throw new ResponseError(404, "Message not found.");
  return message;
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index]! ^ b[index]!;
  return mismatch === 0;
}

function requiredQuery(value: string | undefined, name: string): string {
  if (!value) throw new ResponseError(400, `Query parameter ${name} is required.`);
  return value;
}

function safeQueueJob(value: unknown): MailQueueJob | undefined {
  if (!value || typeof value !== "object") return undefined;
  const job = value as Record<string, unknown>;
  if (
    (job.type === "parse-inbound" || job.type === "send-outbound") &&
    typeof job.messageId === "string"
  ) {
    return { type: job.type, messageId: job.messageId };
  }
  return undefined;
}

function parseQueueJob(value: unknown): MailQueueJob {
  const job = safeQueueJob(value);
  if (!job) throw new Error("The mail queue message is invalid.");
  return job;
}

class ResponseError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}
