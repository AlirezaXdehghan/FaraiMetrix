/**
 * Email: the primary boundary sensor (spec §4.1).
 *
 * Metrix takes email *metadata*: when, which mailbox, which direction, the
 * message ids that tie a thread together, and (transiently, for matching and
 * id extraction only) the subject and attachment filenames. Bodies are never
 * read. The subject is used while the event is matched and then dropped.
 *
 * Two ways in:
 *  - live: anything that can see the mailbox (a Microsoft 365 / Gmail rule, a
 *    mail-flow connector, a small IMAP poller) POSTs `EmailMetadata` to
 *    /v1/email. Confidence B: the mail server's own timestamp.
 *  - historical: `parseEml` reads exported .eml files (scripts/import-eml.ts).
 *    Confidence C: reconstructed from records after the fact.
 */

import type { Confidence, Ref, SourceEventInput } from "../model.ts";
import type { Transient } from "../engine.ts";

/** Every Message-ID in a thread is one identifier system; any shared id joins two jobs. */
export const MESSAGE_REF_SYSTEM = "email-message";

export interface EmailMetadata {
  messageId: string;
  /** Relative to the customer's business: inbound = received by the business. */
  direction: "inbound" | "outbound";
  /** The business mailbox involved (sender for outbound, recipient for inbound). */
  mailbox: string;
  /** The Date header or the server's received/sent time, ISO-8601. */
  date: string;
  inReplyTo?: string;
  references?: string[];
  subject?: string;
  attachments?: string[];
}

export interface EmailOptions {
  confidence: Confidence;
  /** Join emails of one thread into one job (default true). */
  threading: boolean;
}

export function fromEmail(m: EmailMetadata, options: EmailOptions): { input: SourceEventInput; transient: Transient } {
  const messageId = cleanId(m.messageId);
  if (!messageId) throw new Error("messageId is required");
  if (m.direction !== "inbound" && m.direction !== "outbound") throw new Error("direction must be inbound or outbound");
  if (typeof m.mailbox !== "string" || !m.mailbox.includes("@")) throw new Error("mailbox must be an email address");
  const ids = options.threading
    ? [messageId, cleanId(m.inReplyTo), ...(m.references ?? []).map(cleanId)]
    : [messageId];
  const refs: Ref[] = [...new Set(ids.filter((x): x is string => Boolean(x)))].map((id) => ({ system: MESSAGE_REF_SYSTEM, id }));
  const attachments = (m.attachments ?? []).filter((a) => typeof a === "string" && a.length > 0);
  return {
    input: {
      source: "email",
      sourceEventId: messageId,
      eventType: m.direction === "inbound" ? "EMAIL_RECEIVED" : "EMAIL_SENT",
      occurredAt: m.date,
      confidence: options.confidence,
      refs,
      attrs: {
        direction: m.direction,
        mailbox: m.mailbox.trim().toLowerCase(),
        attachmentCount: attachments.length,
      },
    },
    transient: {
      ...(typeof m.subject === "string" ? { subject: m.subject } : {}),
      attachments,
    },
  };
}

function cleanId(id: string | undefined): string | undefined {
  if (typeof id !== "string") return undefined;
  const t = id.trim().replace(/^<|>$/g, "").trim();
  return t || undefined;
}

// ── .eml (RFC 5322) header parsing, for historical import ──────────────────

export interface ParsedEml {
  messageId?: string;
  date?: string;
  from: string[];
  to: string[];
  inReplyTo?: string;
  references: string[];
  subject?: string;
  attachments: string[];
}

/** Headers and attachment filenames only; bodies are skipped. */
export function parseEml(raw: string): ParsedEml {
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const head = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
  const headers = parseHeaders(head);
  const one = (name: string) => headers.get(name)?.[0];
  const addresses = (name: string) =>
    (headers.get(name) ?? []).flatMap((v) => [...v.matchAll(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0].toLowerCase()));
  const date = one("date");
  const parsedDate = date !== undefined && !Number.isNaN(Date.parse(date)) ? new Date(Date.parse(date)).toISOString() : undefined;
  const subject = one("subject");
  return {
    ...(one("message-id") ? { messageId: one("message-id")! } : {}),
    ...(parsedDate ? { date: parsedDate } : {}),
    from: addresses("from"),
    to: [...addresses("to"), ...addresses("cc")],
    ...(one("in-reply-to") ? { inReplyTo: (one("in-reply-to")!.match(/<[^>]+>/)?.[0] ?? one("in-reply-to")!) } : {}),
    references: (headers.get("references") ?? []).flatMap((v) => v.match(/<[^>]+>/g) ?? []),
    ...(subject !== undefined ? { subject: decodeWords(subject) } : {}),
    attachments: attachmentNames(raw),
  };
}

/**
 * Turn a parsed .eml into email metadata from the business's point of view.
 * Null when none of the business's mailboxes sent or received it.
 */
export function emlToMetadata(eml: ParsedEml, mailboxes: string[]): EmailMetadata | null {
  if (!eml.messageId || !eml.date) return null;
  const own = new Set(mailboxes.map((m) => m.toLowerCase()));
  const sender = eml.from.find((a) => own.has(a));
  const recipient = eml.to.find((a) => own.has(a));
  const base = {
    messageId: eml.messageId,
    date: eml.date,
    ...(eml.inReplyTo ? { inReplyTo: eml.inReplyTo } : {}),
    references: eml.references,
    ...(eml.subject !== undefined ? { subject: eml.subject } : {}),
    attachments: eml.attachments,
  };
  if (sender) return { ...base, direction: "outbound", mailbox: sender };
  if (recipient) return { ...base, direction: "inbound", mailbox: recipient };
  return null;
}

function parseHeaders(head: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  // Unfold: a line starting with whitespace continues the previous header.
  const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    out.set(name, [...(out.get(name) ?? []), value]);
  }
  return out;
}

function attachmentNames(raw: string): string[] {
  const names: string[] = [];
  const unfolded = raw.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    if (!/^content-disposition:\s*attachment/i.test(line)) continue;
    const ext = /filename\*=(?:utf-8|iso-8859-1)?'[^']*'([^;\s]+)/i.exec(line);
    const plain = /filename="?([^";]+)"?/i.exec(line);
    if (ext?.[1]) names.push(safeDecodeURI(ext[1]));
    else if (plain?.[1]) names.push(decodeWords(plain[1].trim()));
  }
  return names;
}

/** RFC 2047 encoded words (=?charset?B|Q?...?=), UTF-8 and Latin-1. */
export function decodeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
      const bytes =
        enc.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
      return bytes.toString(/^utf-?8$/i.test(charset) ? "utf8" : "latin1");
    });
}

function safeDecodeURI(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
