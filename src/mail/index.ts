export type MailFolder = "inbox" | "sent" | "outbox" | "drafts" | "archive" | "spam" | "trash";

export type MailDeliveryStatus =
  "draft" | "queued" | "sending" | "sent" | "delivered" | "deferred" | "bounced" | "failed";

export interface MailAddress {
  readonly email: string;
  readonly name?: string;
}

export interface MailRealtimeEvent {
  readonly type: "mail.changed";
  readonly mailboxId: string;
  readonly messageId: string;
  readonly change: "received" | "queued" | "sent" | "delivery" | "read" | "moved";
  readonly at: string;
}

export interface ReplyThreadHeaders {
  readonly "In-Reply-To": string;
  readonly References: string;
}

const REPLY_PREFIX = /^(?:(?:re|fw|fwd)\s*:\s*)+/i;

export function normalizeMailAddress(value: string): string {
  const trimmed = value.trim();
  const bracketed = /<([^<>]+)>$/.exec(trimmed)?.[1] ?? trimmed;
  const normalized = bracketed.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error(`Invalid email address: ${value}`);
  }
  return normalized;
}

export function normalizeMailSubject(value: string): string {
  return value.replace(REPLY_PREFIX, "").trim().replace(/\s+/g, " ");
}

export function replySubject(value: string): string {
  const subject = value.trim();
  return /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

export function createReplyThreadHeaders(
  messageId: string,
  references?: string | null,
): ReplyThreadHeaders {
  const parent = messageId.trim();
  if (!/^<[^<>\s]+>$/.test(parent)) {
    throw new Error("A reply needs a valid RFC 5322 Message-ID.");
  }
  const chain = [...parseReferenceChain(references), parent].slice(-100);
  return { "In-Reply-To": parent, References: chain.join(" ") };
}

export function parseReferenceChain(value?: string | null): string[] {
  if (!value) return [];
  return [...value.matchAll(/<[^<>\s]+>/g)].map((match) => match[0]);
}

export async function mailThreadKey(input: {
  readonly messageId?: string | null;
  readonly inReplyTo?: string | null;
  readonly references?: string | null;
  readonly subject: string;
  readonly participants: readonly string[];
}): Promise<string> {
  const root =
    parseReferenceChain(input.references)[0] ??
    parseReferenceChain(input.inReplyTo)[0] ??
    input.messageId?.trim() ??
    "";
  const participants = [...new Set(input.participants.map(normalizeMailAddress))].sort().join(",");
  const source = root || `${normalizeMailSubject(input.subject).toLowerCase()}\n${participants}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
