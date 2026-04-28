import type { DurableObjectStubLike, Env, StoredAttachmentInput } from "./types";

const REPLY_PREFIX_RE = /^(\s*(?:re|fw|fwd|aw|wg|sv|réf)\s*:\s*)+/i;
const EMAIL_RE = /([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)/g;

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(headers ?? {}),
    },
  });
}

export function text(data: string, status = 200, headers?: HeadersInit): Response {
  return new Response(data, { status, headers });
}

export function badRequest(message: string, details?: unknown): Response {
  return json({ error: message, details }, 400);
}

export function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}

export function notFound(message = "not found"): Response {
  return json({ error: message }, 404);
}

export function serverError(message: string, details?: unknown): Response {
  return json({ error: message, details }, 500);
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function mailboxStub(env: Env, mailboxId: string): DurableObjectStubLike {
  const id = env.MAILBOX.idFromName(normalizeEmail(mailboxId));
  return env.MAILBOX.get(id);
}

export function assertAuthorized(request: Request, env: Env): boolean {
  const incoming = request.headers.get("x-auth-key") ?? "";
  return Boolean(env.AUTH_KEY) && incoming === env.AUTH_KEY;
}

export function hasOutboundEmailBinding(env: Env): boolean {
  return Boolean(env.EMAIL && typeof env.EMAIL.send === "function");
}

export function resolveMailbox(request: Request, env: Env, explicit?: string | null): string | null {
  const url = new URL(request.url);
  const mailbox = explicit ?? url.searchParams.get("mailbox") ?? request.headers.get("x-mailbox") ?? env.DEFAULT_MAILBOX ?? "";
  return mailbox ? normalizeEmail(mailbox) : null;
}

export function allowedDomains(env: Env): string[] {
  return String(env.DOMAINS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedMailbox(mailbox: string, env: Env): boolean {
  const domains = allowedDomains(env);
  if (domains.length === 0) return true;
  const domain = mailbox.split("@")[1] ?? "";
  return domains.includes(domain.toLowerCase());
}

export function parseJson<T>(request: Request): Promise<T> {
  return request.json() as Promise<T>;
}

export function ensureArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function normalizeSubject(subject: string): string {
  return (subject || "(no subject)").replace(REPLY_PREFIX_RE, "").trim().toLowerCase();
}

export function extractEmails(value: string | undefined | null): string[] {
  if (!value) return [];
  const found = value.match(EMAIL_RE) ?? [];
  return [...new Set(found.map((item) => normalizeEmail(item)))];
}

export function buildParticipants(sender: string, recipient: string, cc?: string | null, bcc?: string | null): string {
  const values = new Set<string>([
    ...extractEmails(sender),
    ...extractEmails(recipient),
    ...extractEmails(cc ?? undefined),
    ...extractEmails(bcc ?? undefined),
  ]);
  return [...values].sort().join(",");
}

export function participantsOverlap(left: string, right: string): boolean {
  const a = new Set(left.split(",").map((item) => item.trim()).filter(Boolean));
  const b = new Set(right.split(",").map((item) => item.trim()).filter(Boolean));
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

export function normalizeMessageId(value: string | undefined | null): string {
  if (!value) return "";
  return value.trim().replace(/^<+|>+$/g, "").toLowerCase();
}

export function parseReferences(value: string | undefined | null): string[] {
  if (!value) return [];
  return value
    .split(/\s+/)
    .map((item) => normalizeMessageId(item))
    .filter(Boolean);
}

export function buildSnippet(textValue: string, htmlValue: string): string {
  const source = textValue?.trim() || stripHtml(htmlValue);
  return source.replace(/\s+/g, " ").trim().slice(0, 220);
}

export function stripHtml(html: string | undefined | null): string {
  if (!html) return "";
  return html.replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function toBase64(input: ArrayBuffer | Uint8Array | string): string {
  if (typeof input === "string") {
    return btoa(input);
  }
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(input: string): Uint8Array {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function safeFilename(input: string): string {
  return input.replace(/[\\/:*?"<>|]+/g, "-").trim() || "attachment.bin";
}

export function quoteHtml(textValue: string): string {
  return textValue
    .split("\n")
    .map((line) => `<blockquote>${escapeHtml(line || " ")}</blockquote>`)
    .join("\n");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function makeMessageId(mailbox: string): string {
  const domain = mailbox.split("@")[1] ?? "localhost";
  return `${crypto.randomUUID()}@${domain}`;
}

export function formatAddress(mailbox: string, name?: string): string | { email: string; name: string } {
  if (!name?.trim()) return mailbox;
  return { email: mailbox, name: name.trim() };
}

export function attachmentSize(base64: string): number {
  const trimmed = base64.replace(/=+$/, "");
  return Math.floor((trimmed.length * 3) / 4);
}

export function sanitizeAttachmentInput(input: StoredAttachmentInput): StoredAttachmentInput {
  return {
    filename: safeFilename(input.filename),
    type: input.type || "application/octet-stream",
    disposition: input.disposition ?? "attachment",
    contentId: input.contentId ?? undefined,
    contentBase64: input.contentBase64,
    size: input.size ?? attachmentSize(input.contentBase64),
  };
}
