import PostalMime from "postal-mime";
import type { Env, IncomingEmailPayload, StoredAttachmentInput } from "./types";
import { MailboxDO } from "./mailbox-do";
import {
  assertAuthorized,
  badRequest,
  buildSnippet,
  isAllowedMailbox,
  json,
  mailboxStub,
  normalizeEmail,
  normalizeMessageId,
  notFound,
  parseJson,
  resolveMailbox,
  serverError,
  toBase64,
  unauthorized,
} from "./utils";

export { MailboxDO };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "ni-mail" });
    }

    if (!assertAuthorized(request, env)) {
      return unauthorized();
    }

    try {
      if (request.method === "GET" && url.pathname === "/latest") {
        const mailbox = resolveMailbox(request, env);
        if (!mailbox) return badRequest("mailbox is required");
        return proxyToMailbox(env, mailbox, `/internal/emails/latest?folder=inbox`);
      }

      if (request.method === "GET" && url.pathname === "/mails") {
        const mailbox = resolveMailbox(request, env);
        if (!mailbox) return badRequest("mailbox is required");
        const search = new URLSearchParams(url.search);
        if (!search.has("folder")) search.set("folder", "inbox");
        return proxyToMailbox(env, mailbox, `/internal/emails?${search.toString()}`);
      }

      const legacyMailMatch = url.pathname.match(/^\/mail\/([^/]+)$/);
      if (request.method === "GET" && legacyMailMatch) {
        const mailbox = resolveMailbox(request, env);
        if (!mailbox) return badRequest("mailbox is required");
        return proxyToMailbox(env, mailbox, `/internal/emails/${encodeURIComponent(decodeURIComponent(legacyMailMatch[1]!))}`);
      }

      if (request.method === "DELETE" && url.pathname === "/mails") {
        const mailbox = resolveMailbox(request, env);
        if (!mailbox) return badRequest("mailbox is required");
        const folder = url.searchParams.get("folder") ?? "inbox";
        return proxyToMailbox(env, mailbox, `/internal/inbox?folder=${encodeURIComponent(folder)}`, { method: "DELETE" });
      }

      const mailboxBase = url.pathname.match(/^\/api\/mailboxes\/([^/]+)(\/.*)?$/);
      if (mailboxBase) {
        const mailboxId = normalizeEmail(decodeURIComponent(mailboxBase[1]!));
        if (!isAllowedMailbox(mailboxId, env)) {
          return badRequest(`mailbox domain is not allowed: ${mailboxId}`);
        }

        const subPath = mailboxBase[2] ?? "";

        if (request.method === "GET" && subPath === "/latest") {
          const folder = url.searchParams.get("folder") ?? "inbox";
          return proxyToMailbox(env, mailboxId, `/internal/emails/latest?folder=${encodeURIComponent(folder)}`);
        }

        if (request.method === "GET" && subPath === "/emails") {
          const search = new URLSearchParams(url.search);
          if (!search.has("folder")) search.set("folder", "inbox");
          return proxyToMailbox(env, mailboxId, `/internal/emails?${search.toString()}`);
        }

        const emailMatch = subPath.match(/^\/emails\/([^/]+)$/);
        if (request.method === "GET" && emailMatch) {
          return proxyToMailbox(env, mailboxId, `/internal/emails/${encodeURIComponent(decodeURIComponent(emailMatch[1]!))}`);
        }

        const readMatch = subPath.match(/^\/emails\/([^/]+)\/read$/);
        if (request.method === "POST" && readMatch) {
          return proxyToMailbox(env, mailboxId, `/internal/emails/${encodeURIComponent(decodeURIComponent(readMatch[1]!))}/read`, { method: "POST" });
        }

        const threadMatch = subPath.match(/^\/threads\/([^/]+)$/);
        if (request.method === "GET" && threadMatch) {
          return proxyToMailbox(env, mailboxId, `/internal/threads/${encodeURIComponent(decodeURIComponent(threadMatch[1]!))}`);
        }

        if (request.method === "POST" && subPath === "/send") {
          const body = await parseJson<Record<string, unknown>>(request);
          return proxyToMailbox(env, mailboxId, `/internal/send`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...body, mailboxId }),
          });
        }

        if (request.method === "POST" && subPath === "/reply") {
          const body = await parseJson<Record<string, unknown>>(request);
          return proxyToMailbox(env, mailboxId, `/internal/reply`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...body, mailboxId }),
          });
        }

        if (request.method === "POST" && subPath === "/forward") {
          const body = await parseJson<Record<string, unknown>>(request);
          return proxyToMailbox(env, mailboxId, `/internal/forward`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...body, mailboxId }),
          });
        }

        if (request.method === "DELETE" && subPath === "/emails") {
          const folder = url.searchParams.get("folder") ?? "inbox";
          return proxyToMailbox(env, mailboxId, `/internal/inbox?folder=${encodeURIComponent(folder)}`, { method: "DELETE" });
        }
      }

      const attachmentMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)$/);
      if (request.method === "GET" && attachmentMatch) {
        const mailbox = resolveMailbox(request, env);
        if (!mailbox) return badRequest("mailbox is required");
        return proxyToMailbox(env, mailbox, `/internal/attachments/${encodeURIComponent(decodeURIComponent(attachmentMatch[1]!))}`);
      }

      return notFound("unknown route");
    } catch (error) {
      return serverError("request failed", serializeError(error));
    }
  },

  async email(message: ForwardableEmailMessageLike, env: Env): Promise<void> {
    const mailbox = normalizeEmail(message.to);
    if (!isAllowedMailbox(mailbox, env)) {
      message.setReject(`mailbox domain not allowed: ${mailbox}`);
      return;
    }

    try {
      const parser = new PostalMime();
      const raw = await new Response(message.raw).arrayBuffer();
      const parsed = await parser.parse(raw);
      const headers = Object.fromEntries(Array.from(message.headers.entries()).map(([key, value]) => [key.toLowerCase(), value]));
      const subject = parsed.subject ?? "(no subject)";
      const bodyText = parsed.text ?? "";
      const bodyHtml = parsed.html ?? "";
      const attachments: StoredAttachmentInput[] = (parsed.attachments ?? []).map((attachment) => ({
        filename: attachment.filename ?? "attachment.bin",
        type: attachment.mimeType ?? "application/octet-stream",
        disposition: attachment.disposition === "inline" ? "inline" : "attachment",
        contentId: attachment.contentId ?? undefined,
        contentBase64: toBase64(attachment.content ?? new Uint8Array()),
      }));

      const payload: IncomingEmailPayload = {
        id: crypto.randomUUID(),
        folderId: "inbox",
        from: normalizeEmail(message.from),
        to: mailbox,
        cc: headers["cc"] ?? null,
        bcc: headers["bcc"] ?? null,
        subject,
        bodyText,
        bodyHtml,
        snippet: buildSnippet(bodyText, bodyHtml),
        date: headers["date"] ? new Date(headers["date"]).toISOString() : new Date().toISOString(),
        messageId: normalizeMessageId(headers["message-id"] ?? `${crypto.randomUUID()}@${mailbox.split("@")[1] ?? "localhost"}`),
        inReplyTo: normalizeMessageId(headers["in-reply-to"] ?? ""),
        references: headers["references"] ?? null,
        rawHeaders: headers,
        attachments,
      };

      const response = await proxyToMailbox(env, mailbox, `/internal/incoming`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const textBody = await response.text();
        throw new Error(`mailbox storage failed: ${textBody}`);
      }
    } catch (error) {
      message.setReject(`worker failed to process email: ${stringifyError(error)}`);
    }
  },
};

type ForwardableEmailMessageLike = {
  from: string;
  to: string;
  headers: Headers;
  raw: ReadableStream<Uint8Array>;
  setReject(reason: string): void;
};

async function proxyToMailbox(env: Env, mailboxId: string, path: string, init?: RequestInit): Promise<Response> {
  const stub = mailboxStub(env, mailboxId);
  const request = new Request(`https://mailbox.internal${path}`, init);
  return await stub.fetch(request);
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
