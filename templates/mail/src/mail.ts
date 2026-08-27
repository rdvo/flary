import PostalMime from "postal-mime";
import {
  createReplyThreadHeaders,
  mailThreadKey,
  normalizeMailAddress,
  normalizeMailSubject,
  replySubject,
  type MailRealtimeEvent,
} from "flary/mail";

import type { MailRoom } from "./mail-room";

export type MailQueueJob =
  | { readonly type: "parse-inbound"; readonly messageId: string }
  | { readonly type: "send-outbound"; readonly messageId: string };

export type ComposeAttachment = {
  readonly filename: string;
  readonly type: string;
  readonly contentBase64: string;
};

export type ComposeInput = {
  readonly mailboxId: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly replyToMessageId?: string;
  readonly attachments?: readonly ComposeAttachment[];
  readonly draft?: boolean;
};

type MailboxRow = { id: string; address: string; name: string };
type MessageRow = {
  id: string;
  mailboxId: string;
  threadId: string | null;
  status: string;
  messageId: string | null;
  inReplyTo: string | null;
  referencesHeader: string | null;
  fromAddress: string;
  toJson: string;
  ccJson: string;
  bccJson: string;
  subject: string;
  textBody: string;
  htmlBody: string | null;
  createdAt: number;
};

export async function receiveEmail(
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  if (message.rawSize > 25 * 1024 * 1024) {
    message.setReject("Message exceeds the 25 MiB mailbox limit.");
    return;
  }
  const address = normalizeMailAddress(message.to);
  if (!configuredAddresses(env).has(address)) {
    message.setReject("This mailbox does not exist.");
    return;
  }
  const mailbox = await ensureMailbox(env, address);
  const id = crypto.randomUUID();
  const rawObjectKey = `raw/${mailbox.id}/${id}.eml`;
  const rawBody = new FixedLengthStream(message.rawSize);
  await Promise.all([
    message.raw.pipeTo(rawBody.writable),
    env.MAIL_STORAGE.put(rawObjectKey, rawBody.readable, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: { mailboxId: mailbox.id, messageId: id },
    }),
  ]);

  const rfcMessageId = message.headers.get("message-id")?.trim() || null;
  const inserted = await env.MAIL_DB.prepare(
    `
    INSERT OR IGNORE INTO mail_message (
      id, mailbox_id, direction, folder, status, message_id, from_address,
      to_json, subject, raw_object_key, is_read, created_at, updated_at
    ) VALUES (?, ?, 'inbound', 'inbox', 'queued', ?, ?, ?, ?, ?, 0, ?, ?)
  `
  )
    .bind(
      id,
      mailbox.id,
      rfcMessageId,
      normalizeMailAddress(message.from),
      JSON.stringify([address]),
      message.headers.get("subject") ?? "",
      rawObjectKey,
      Date.now(),
      Date.now()
    )
    .run();
  if (!inserted.meta.changes) {
    await env.MAIL_STORAGE.delete(rawObjectKey);
    return;
  }
  await env.MAIL_QUEUE.send({
    type: "parse-inbound",
    messageId: id,
  } satisfies MailQueueJob);
}

export async function processInbound(
  env: Env,
  messageId: string
): Promise<void> {
  const pending = await env.MAIL_DB.prepare(
    `
    SELECT id, mailbox_id AS mailboxId, raw_object_key AS rawObjectKey
    FROM mail_message WHERE id = ? AND direction = 'inbound' AND status = 'queued'
  `
  )
    .bind(messageId)
    .first<{ id: string; mailboxId: string; rawObjectKey: string }>();
  if (!pending) return;
  const raw = await env.MAIL_STORAGE.get(pending.rawObjectKey);
  if (!raw) throw new Error(`Raw inbound message ${messageId} is missing.`);

  const parsed = await new PostalMime().parse(await raw.arrayBuffer());
  const fromAddress = parsed.from?.address
    ? normalizeMailAddress(parsed.from.address)
    : "unknown@invalid.local";
  const to = (parsed.to ?? []).flatMap((address) =>
    address.address ? [normalizeMailAddress(address.address)] : []
  );
  const cc = (parsed.cc ?? []).flatMap((address) =>
    address.address ? [normalizeMailAddress(address.address)] : []
  );
  const participants = [fromAddress, ...to, ...cc];
  const messageHeader = parsed.messageId?.trim() || null;
  const references = Array.isArray(parsed.references)
    ? parsed.references.join(" ")
    : parsed.references ?? null;
  const threadId = await stableId(
    `${pending.mailboxId}:${await mailThreadKey({
      messageId: messageHeader,
      inReplyTo: parsed.inReplyTo,
      references,
      subject: parsed.subject ?? "",
      participants,
    })}`
  );
  const now = parsed.date ? new Date(parsed.date).getTime() : Date.now();
  const safeNow = Number.isFinite(now) ? now : Date.now();
  const attachmentStatements: D1PreparedStatement[] = [];

  for (const attachment of parsed.attachments ?? []) {
    const attachmentId = crypto.randomUUID();
    const filename = attachment.filename || "attachment";
    const objectKey = `attachments/${pending.mailboxId}/${messageId}/${attachmentId}`;
    await env.MAIL_STORAGE.put(objectKey, attachment.content, {
      httpMetadata: {
        contentType: attachment.mimeType || "application/octet-stream",
      },
      customMetadata: { filename, messageId },
    });
    attachmentStatements.push(
      env.MAIL_DB.prepare(
        `
      INSERT INTO mail_attachment (
        id, message_id, filename, content_type, size, object_key,
        content_id, disposition
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
      ).bind(
        attachmentId,
        messageId,
        filename,
        attachment.mimeType || "application/octet-stream",
        contentByteLength(attachment.content),
        objectKey,
        attachment.contentId ?? null,
        attachment.disposition === "inline" ? "inline" : "attachment"
      )
    );
  }

  await env.MAIL_DB.batch([
    env.MAIL_DB.prepare(
      `
      INSERT INTO mail_thread (
        id, mailbox_id, subject, participants_json, message_count,
        unread_count, last_message_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        participants_json = excluded.participants_json,
        message_count = mail_thread.message_count + 1,
        unread_count = mail_thread.unread_count + 1,
        last_message_at = MAX(mail_thread.last_message_at, excluded.last_message_at),
        updated_at = excluded.updated_at
    `
    ).bind(
      threadId,
      pending.mailboxId,
      normalizeMailSubject(parsed.subject ?? "") || "(no subject)",
      JSON.stringify([...new Set(participants)]),
      safeNow,
      safeNow,
      Date.now()
    ),
    env.MAIL_DB.prepare(
      `
      UPDATE mail_message SET
        thread_id = ?, status = 'delivered', message_id = COALESCE(?, message_id),
        in_reply_to = ?, references_header = ?, from_address = ?, from_name = ?,
        to_json = ?, cc_json = ?, reply_to = ?, subject = ?, text_body = ?,
        html_body = ?, created_at = ?, delivered_at = ?, updated_at = ?
      WHERE id = ?
    `
    ).bind(
      threadId,
      messageHeader,
      parsed.inReplyTo ?? null,
      references,
      fromAddress,
      parsed.from?.name ?? null,
      JSON.stringify(to),
      JSON.stringify(cc),
      parsed.replyTo?.[0]?.address ?? null,
      parsed.subject ?? "",
      parsed.text ?? "",
      parsed.html || null,
      safeNow,
      Date.now(),
      Date.now(),
      messageId
    ),
    ...attachmentStatements,
  ]);
  await broadcast(env, pending.mailboxId, messageId, "received");
}

export async function composeMessage(
  env: Env,
  userId: string,
  input: ComposeInput
): Promise<{ id: string; threadId: string }> {
  const mailbox = await env.MAIL_DB.prepare(
    "SELECT id, address, name FROM mailbox WHERE id = ?"
  )
    .bind(input.mailboxId)
    .first<MailboxRow>();
  if (!mailbox) throw new Error("Mailbox not found.");

  const to = input.to.map(normalizeMailAddress);
  const cc = (input.cc ?? []).map(normalizeMailAddress);
  const bcc = (input.bcc ?? []).map(normalizeMailAddress);
  if (to.length + cc.length + bcc.length === 0)
    throw new Error("Add at least one recipient.");
  if (to.length + cc.length + bcc.length > 50)
    throw new Error("One message can have at most 50 recipients.");

  let threadId: string;
  let subject = input.subject.trim();
  let headers: { "In-Reply-To": string; References: string } | undefined;
  if (input.replyToMessageId) {
    const parent = await env.MAIL_DB.prepare(
      `
      SELECT thread_id AS threadId, message_id AS messageId,
             references_header AS referencesHeader, subject
      FROM mail_message WHERE id = ? AND mailbox_id = ?
    `
    )
      .bind(input.replyToMessageId, mailbox.id)
      .first<{
        threadId: string | null;
        messageId: string | null;
        referencesHeader: string | null;
        subject: string;
      }>();
    if (!parent?.threadId || !parent.messageId)
      throw new Error("The original message cannot be used for a reply.");
    threadId = parent.threadId;
    subject = replySubject(parent.subject);
    headers = createReplyThreadHeaders(
      parent.messageId,
      parent.referencesHeader
    );
  } else {
    threadId = await stableId(
      `${mailbox.id}:${await mailThreadKey({
        subject,
        participants: [mailbox.address, ...to, ...cc],
      })}`
    );
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const attachments = input.attachments ?? [];
  const totalAttachmentBytes = attachments.reduce(
    (total, item) => total + base64ByteLength(item.contentBase64),
    0
  );
  if (totalAttachmentBytes > 4 * 1024 * 1024)
    throw new Error("Attachments must total 4 MiB or less.");
  const attachmentStatements: D1PreparedStatement[] = [];
  for (const item of attachments) {
    const attachmentId = crypto.randomUUID();
    const objectKey = `attachments/${mailbox.id}/${id}/${attachmentId}`;
    const content = decodeBase64(item.contentBase64);
    await env.MAIL_STORAGE.put(objectKey, content, {
      httpMetadata: { contentType: item.type || "application/octet-stream" },
      customMetadata: { filename: item.filename, messageId: id },
    });
    attachmentStatements.push(
      env.MAIL_DB.prepare(
        `
      INSERT INTO mail_attachment (
        id, message_id, filename, content_type, size, object_key, disposition
      ) VALUES (?, ?, ?, ?, ?, ?, 'attachment')
    `
      ).bind(
        attachmentId,
        id,
        item.filename,
        item.type || "application/octet-stream",
        content.byteLength,
        objectKey
      )
    );
  }

  await env.MAIL_DB.batch([
    env.MAIL_DB.prepare(
      `
      INSERT INTO mail_thread (
        id, mailbox_id, subject, participants_json, message_count,
        unread_count, last_message_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        participants_json = excluded.participants_json,
        message_count = mail_thread.message_count + 1,
        last_message_at = excluded.last_message_at,
        updated_at = excluded.updated_at
    `
    ).bind(
      threadId,
      mailbox.id,
      normalizeMailSubject(subject) || "(no subject)",
      JSON.stringify([mailbox.address, ...to, ...cc]),
      now,
      now,
      now
    ),
    env.MAIL_DB.prepare(
      `
      INSERT INTO mail_message (
        id, mailbox_id, thread_id, direction, folder, status,
        in_reply_to, references_header, from_address, from_name,
        to_json, cc_json, bcc_json, subject, text_body, html_body,
        is_read, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `
    ).bind(
      id,
      mailbox.id,
      threadId,
      input.draft ? "drafts" : "outbox",
      input.draft ? "draft" : "queued",
      headers?.["In-Reply-To"] ?? null,
      headers?.References ?? null,
      mailbox.address,
      mailbox.name,
      JSON.stringify(to),
      JSON.stringify(cc),
      JSON.stringify(bcc),
      subject,
      input.text,
      input.html ?? null,
      userId,
      now,
      now
    ),
    ...attachmentStatements,
  ]);
  if (!input.draft) {
    await env.MAIL_QUEUE.send({
      type: "send-outbound",
      messageId: id,
    } satisfies MailQueueJob);
    await broadcast(env, mailbox.id, id, "queued");
  }
  return { id, threadId };
}

export async function sendOutbound(env: Env, messageId: string): Promise<void> {
  const claimed = await env.MAIL_DB.prepare(
    `
    UPDATE mail_message SET status = 'sending', updated_at = ?
    WHERE id = ? AND direction = 'outbound' AND status = 'queued'
  `
  )
    .bind(Date.now(), messageId)
    .run();
  if (!claimed.meta.changes) return;

  const message = await env.MAIL_DB.prepare(
    `
    SELECT id, mailbox_id AS mailboxId, thread_id AS threadId, status,
           message_id AS messageId, in_reply_to AS inReplyTo,
           references_header AS referencesHeader,
           from_address AS fromAddress, to_json AS toJson, cc_json AS ccJson,
           bcc_json AS bccJson, subject, text_body AS textBody,
           html_body AS htmlBody, created_at AS createdAt
    FROM mail_message WHERE id = ?
  `
  )
    .bind(messageId)
    .first<MessageRow>();
  if (!message) return;

  const attachmentRows = await env.MAIL_DB.prepare(
    `
    SELECT filename, content_type AS contentType, object_key AS objectKey,
           content_id AS contentId, disposition
    FROM mail_attachment WHERE message_id = ? ORDER BY created_at
  `
  )
    .bind(messageId)
    .all<{
      filename: string;
      contentType: string;
      objectKey: string;
      contentId: string | null;
      disposition: "attachment" | "inline";
    }>();
  const attachments: EmailAttachment[] = [];
  for (const row of attachmentRows.results) {
    const object = await env.MAIL_STORAGE.get(row.objectKey);
    if (!object) throw new Error(`Attachment ${row.filename} is missing.`);
    const content = await object.arrayBuffer();
    attachments.push(
      row.disposition === "inline" && row.contentId
        ? {
            disposition: "inline",
            contentId: row.contentId,
            filename: row.filename,
            type: row.contentType,
            content,
          }
        : {
            disposition: "attachment",
            filename: row.filename,
            type: row.contentType,
            content,
          }
    );
  }

  try {
    const result = await env.EMAIL.send({
      from: message.fromAddress,
      to: parseAddressJson(message.toJson),
      cc: parseAddressJson(message.ccJson),
      bcc: parseAddressJson(message.bccJson),
      subject: message.subject,
      text: message.textBody,
      ...(message.htmlBody ? { html: message.htmlBody } : {}),
      ...(message.inReplyTo && message.referencesHeader
        ? {
            headers: {
              "In-Reply-To": message.inReplyTo,
              References: message.referencesHeader,
            },
          }
        : {}),
      ...(attachments.length ? { attachments } : {}),
    });
    await env.MAIL_DB.prepare(
      `
      UPDATE mail_message SET folder = 'sent', status = 'sent', message_id = ?,
        sent_at = ?, updated_at = ? WHERE id = ? AND status = 'sending'
    `
    )
      .bind(result.messageId, Date.now(), Date.now(), messageId)
      .run();
    await broadcast(env, message.mailboxId, messageId, "sent");
  } catch (error) {
    await env.MAIL_DB.prepare(
      `
      UPDATE mail_message SET status = 'queued', error = ?, updated_at = ?
      WHERE id = ? AND status = 'sending'
    `
    )
      .bind(
        error instanceof Error ? error.message : "Email sending failed.",
        Date.now(),
        messageId
      )
      .run();
    throw error;
  }
}

export async function failOutbound(
  env: Env,
  messageId: string,
  reason: string
): Promise<void> {
  const row = await env.MAIL_DB.prepare(
    `
    UPDATE mail_message SET status = 'failed', error = ?, updated_at = ?
    WHERE id = ? AND status IN ('queued','sending')
    RETURNING mailbox_id AS mailboxId
  `
  )
    .bind(reason, Date.now(), messageId)
    .first<{ mailboxId: string }>();
  if (row) await broadcast(env, row.mailboxId, messageId, "delivery");
}

export async function processDeliveryEvent(
  env: Env,
  event: unknown
): Promise<boolean> {
  if (!event || typeof event !== "object") return false;
  const root = event as Record<string, unknown>;
  const type = typeof root.type === "string" ? root.type : "";
  if (!type.startsWith("cf.email.sending.message.")) return false;
  const payload =
    root.payload && typeof root.payload === "object"
      ? (root.payload as Record<string, unknown>)
      : {};
  const rfcMessageId =
    typeof payload.messageId === "string" ? payload.messageId : undefined;
  if (!rfcMessageId) return true;
  const suffix = type.split(".").at(-1);
  const status =
    suffix === "delivered"
      ? "delivered"
      : suffix === "deferred"
      ? "deferred"
      : suffix === "bounced"
      ? "bounced"
      : "failed";
  const row = await env.MAIL_DB.prepare(
    `
    UPDATE mail_message SET status = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
      error = CASE WHEN ? = 'delivered' THEN NULL ELSE ? END, updated_at = ?
    WHERE message_id = ? RETURNING id, mailbox_id AS mailboxId
  `
  )
    .bind(
      status,
      status,
      Date.now(),
      status,
      suffix ?? "failed",
      Date.now(),
      rfcMessageId
    )
    .first<{ id: string; mailboxId: string }>();
  if (row) await broadcast(env, row.mailboxId, row.id, "delivery");
  return true;
}

export async function broadcast(
  env: Env,
  mailboxId: string,
  messageId: string,
  change: MailRealtimeEvent["change"]
): Promise<void> {
  const room = env.MAIL_ROOM.getByName(
    mailboxId
  ) as DurableObjectStub<MailRoom>;
  await room.broadcast({
    type: "mail.changed",
    mailboxId,
    messageId,
    change,
    at: new Date().toISOString(),
  });
}

export function configuredAddresses(env: Env): Set<string> {
  return new Set(env.MAILBOX_ADDRESSES.split(",").map(normalizeMailAddress));
}

async function ensureMailbox(env: Env, address: string): Promise<MailboxRow> {
  const id = await stableId(address);
  const name = address
    .split("@")[0]!
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  await env.MAIL_DB.prepare(
    "INSERT OR IGNORE INTO mailbox (id, address, name) VALUES (?, ?, ?)"
  )
    .bind(id, address, name)
    .run();
  const mailbox = await env.MAIL_DB.prepare(
    "SELECT id, address, name FROM mailbox WHERE address = ?"
  )
    .bind(address)
    .first<MailboxRow>();
  if (!mailbox) throw new Error(`Mailbox ${address} could not be created.`);
  return mailbox;
}

export async function provisionConfiguredMailboxes(
  env: Env
): Promise<MailboxRow[]> {
  const rows: MailboxRow[] = [];
  for (const address of configuredAddresses(env))
    rows.push(await ensureMailbox(env, address));
  return rows;
}

async function stableId(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

function parseAddressJson(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) =>
    typeof item === "string" ? [normalizeMailAddress(item)] : []
  );
}

function decodeBase64(value: string): ArrayBuffer {
  const bytes = Uint8Array.from(atob(value), (character) =>
    character.charCodeAt(0)
  );
  return bytes.buffer;
}

function base64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function contentByteLength(value: string | ArrayBuffer | Uint8Array): number {
  return typeof value === "string"
    ? new TextEncoder().encode(value).byteLength
    : value.byteLength;
}
