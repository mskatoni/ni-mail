import { DurableObject } from "cloudflare:workers";
import type {
  DurableObjectStateLike,
  Env,
  ForwardRequestBody,
  IncomingEmailPayload,
  ReplyRequestBody,
  SendRequestBody,
  StoredAttachmentInput,
  StoredAttachmentRecord,
} from "./types";
import {
  badRequest,
  buildParticipants,
  buildSnippet,
  ensureArray,
  escapeHtml,
  formatAddress,
  fromBase64,
  json,
  hasOutboundEmailBinding,
  makeMessageId,
  normalizeEmail,
  normalizeMessageId,
  normalizeSubject,
  notFound,
  parseReferences,
  participantsOverlap,
  quoteHtml,
  safeFilename,
  sanitizeAttachmentInput,
  serverError,
  stripHtml,
  text,
  toBase64,
} from "./utils";

type EmailRow = {
  id: string;
  folder_id: string;
  subject: string | null;
  sender: string | null;
  recipient: string | null;
  cc: string | null;
  bcc: string | null;
  date: string;
  read: number;
  starred: number;
  body_text: string | null;
  body_html: string | null;
  snippet: string | null;
  normalized_subject: string | null;
  participants: string | null;
  in_reply_to: string | null;
  email_references: string | null;
  thread_id: string | null;
  message_id: string | null;
  raw_headers: string | null;
};

type ListSummary = {
  id: string;
  folderId: string;
  subject: string;
  sender: string;
  recipient: string;
  date: string;
  read: boolean;
  starred: boolean;
  snippet: string;
  threadId: string;
  messageId: string;
  attachmentCount: number;
};

type ThreadSummary = {
  threadId: string;
  subject: string;
  lastDate: string;
  lastSender: string;
  lastRecipient: string;
  snippet: string;
  unreadCount: number;
  messageCount: number;
  latestEmailId: string;
  attachmentCount: number;
};

const FOLDERS = [
  { id: "inbox", name: "Inbox", deletable: 0 },
  { id: "sent", name: "Sent", deletable: 0 },
  { id: "archive", name: "Archive", deletable: 0 },
  { id: "trash", name: "Trash", deletable: 0 },
];

export class MailboxDO extends DurableObject {
  private state: DurableObjectStateLike;
  private env: Env;
  private sql: DurableObjectStateLike["storage"]["sql"];

  constructor(state: DurableObjectStateLike, env: Env) {
    super(state as never, env as never);
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    void this.state.blockConcurrencyWhile(async () => {
      this.initSchema();
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/internal/incoming") {
        const payload = (await request.json()) as IncomingEmailPayload;
        return json(await this.storeIncoming(payload));
      }

      if (request.method === "GET" && url.pathname === "/internal/emails/latest") {
        const folderId = url.searchParams.get("folder") ?? "inbox";
        const email = this.getLatestEmail(folderId);
        return email ? json(email) : notFound("no mail");
      }

      if (request.method === "GET" && url.pathname === "/internal/emails") {
        const threaded = ["1", "true"].includes((url.searchParams.get("threaded") ?? "").toLowerCase());
        const folderId = url.searchParams.get("folder") ?? "inbox";
        const limit = clampNumber(url.searchParams.get("limit"), 10, 1, 200);
        const offset = clampNumber(url.searchParams.get("offset"), 0, 0, 10000);
        const sortColumn = normalizeSortColumn(url.searchParams.get("sortColumn"));
        const sortDirection = normalizeSortDirection(url.searchParams.get("sortDirection"));
        const q = (url.searchParams.get("q") ?? "").trim();

        if (threaded) {
          return json(this.listThreads({ folderId, limit, offset, q, sortDirection }));
        }
        return json(this.listEmails({ folderId, limit, offset, q, sortColumn, sortDirection }));
      }

      const emailMatch = url.pathname.match(/^\/internal\/emails\/([^/]+)$/);
      if (request.method === "GET" && emailMatch) {
        const email = this.getEmailById(decodeURIComponent(emailMatch[1]!));
        return email ? json(email) : notFound();
      }

      if (request.method === "POST" && emailMatch && url.pathname.endsWith("/read") === false) {
        return badRequest("unsupported email mutation");
      }

      const readMatch = url.pathname.match(/^\/internal\/emails\/([^/]+)\/read$/);
      if (request.method === "POST" && readMatch) {
        const id = decodeURIComponent(readMatch[1]!);
        this.sql.exec(`UPDATE emails SET read = 1 WHERE id = ?`, id);
        return json({ ok: true, id });
      }

      const threadMatch = url.pathname.match(/^\/internal\/threads\/([^/]+)$/);
      if (request.method === "GET" && threadMatch) {
        return json(this.getThread(decodeURIComponent(threadMatch[1]!)));
      }

      const attachmentMatch = url.pathname.match(/^\/internal\/attachments\/([^/]+)$/);
      if (request.method === "GET" && attachmentMatch) {
        return await this.serveAttachment(decodeURIComponent(attachmentMatch[1]!));
      }

      if (request.method === "POST" && url.pathname === "/internal/send") {
        const body = (await request.json()) as SendRequestBody & { mailboxId: string };
        return json(await this.sendNew(body.mailboxId, body));
      }

      if (request.method === "POST" && url.pathname === "/internal/reply") {
        const body = (await request.json()) as ReplyRequestBody & { mailboxId: string };
        return json(await this.reply(body.mailboxId, body));
      }

      if (request.method === "POST" && url.pathname === "/internal/forward") {
        const body = (await request.json()) as ForwardRequestBody & { mailboxId: string };
        return json(await this.forward(body.mailboxId, body));
      }

      if (request.method === "DELETE" && url.pathname === "/internal/inbox") {
        const deleted = await this.clearFolder(url.searchParams.get("folder") ?? "inbox");
        return json({ ok: true, deleted });
      }

      return notFound("unknown route");
    } catch (error) {
      const maybeStatus = (error as Error & { status?: number })?.status;
      if (maybeStatus && maybeStatus >= 400 && maybeStatus < 600) {
        return json({ error: (error as Error).message }, maybeStatus);
      }
      return serverError("mailbox operation failed", serializeError(error));
    }
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        is_deletable INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS emails (
        id TEXT PRIMARY KEY,
        folder_id TEXT NOT NULL,
        subject TEXT,
        sender TEXT,
        recipient TEXT,
        cc TEXT,
        bcc TEXT,
        date TEXT,
        read INTEGER NOT NULL DEFAULT 0,
        starred INTEGER NOT NULL DEFAULT 0,
        body_text TEXT,
        body_html TEXT,
        snippet TEXT,
        normalized_subject TEXT,
        participants TEXT,
        in_reply_to TEXT,
        email_references TEXT,
        thread_id TEXT,
        message_id TEXT,
        raw_headers TEXT,
        FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        email_id TEXT NOT NULL,
        r2_key TEXT NOT NULL,
        filename TEXT NOT NULL,
        mimetype TEXT NOT NULL,
        size INTEGER NOT NULL,
        content_id TEXT,
        disposition TEXT,
        FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_emails_folder_date ON emails(folder_id, date DESC);
      CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id, date DESC);
      CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
      CREATE INDEX IF NOT EXISTS idx_emails_subject_date ON emails(normalized_subject, date DESC);
    `);

    for (const folder of FOLDERS) {
      this.sql.exec(
        `INSERT OR IGNORE INTO folders (id, name, is_deletable) VALUES (?, ?, ?)`,
        folder.id,
        folder.name,
        folder.deletable,
      );
    }
  }

  private async storeIncoming(payload: IncomingEmailPayload): Promise<{ ok: true; emailId: string; threadId: string }> {
    const normalizedSubject = normalizeSubject(payload.subject);
    const participants = buildParticipants(payload.from, payload.to, payload.cc, payload.bcc);
    const threadId = this.resolveThreadId({
      normalizedSubject,
      participants,
      inReplyTo: payload.inReplyTo,
      references: payload.references,
      messageId: payload.messageId,
      date: payload.date,
    });

    const emailId = payload.id || crypto.randomUUID();
    this.insertEmail({
      id: emailId,
      folderId: payload.folderId,
      subject: payload.subject,
      sender: payload.from,
      recipient: payload.to,
      cc: payload.cc ?? null,
      bcc: payload.bcc ?? null,
      date: payload.date,
      read: 0,
      bodyText: payload.bodyText,
      bodyHtml: payload.bodyHtml,
      snippet: payload.snippet,
      normalizedSubject,
      participants,
      inReplyTo: normalizeMessageId(payload.inReplyTo),
      references: payload.references ?? null,
      threadId,
      messageId: normalizeMessageId(payload.messageId),
      rawHeaders: JSON.stringify(payload.rawHeaders),
    });

    await this.storeAttachments(emailId, payload.attachments);
    return { ok: true, emailId, threadId };
  }

  private listEmails(params: {
    folderId: string;
    limit: number;
    offset: number;
    q: string;
    sortColumn: "date" | "subject" | "sender";
    sortDirection: "ASC" | "DESC";
  }): { items: ListSummary[]; total: number } {
    const rows = this.queryEmailRows(params.folderId, params.q);
    const sorted = rows.sort((left, right) => compareEmailRows(left, right, params.sortColumn, params.sortDirection));
    const sliced = sorted.slice(params.offset, params.offset + params.limit);

    return {
      items: sliced.map((row) => this.toListSummary(row)),
      total: sorted.length,
    };
  }

  private listThreads(params: {
    folderId: string;
    limit: number;
    offset: number;
    q: string;
    sortDirection: "ASC" | "DESC";
  }): { items: ThreadSummary[]; total: number } {
    const rows = this.queryEmailRows(params.folderId, params.q);
    const groups = new Map<string, EmailRow[]>();

    for (const row of rows) {
      const key = row.thread_id || row.id;
      const bucket = groups.get(key) ?? [];
      bucket.push(row);
      groups.set(key, bucket);
    }

    const summaries: ThreadSummary[] = [...groups.entries()].map(([threadId, items]) => {
      items.sort((a, b) => compareIso(a.date, b.date, "DESC"));
      const latest = items[0]!;
      const unreadCount = items.filter((item) => item.folder_id === "inbox" && item.read === 0).length;
      const attachmentCount = items.reduce((sum, item) => sum + this.countAttachments(item.id), 0);
      return {
        threadId,
        subject: latest.subject ?? "(no subject)",
        lastDate: latest.date,
        lastSender: latest.sender ?? "",
        lastRecipient: latest.recipient ?? "",
        snippet: latest.snippet ?? "",
        unreadCount,
        messageCount: items.length,
        latestEmailId: latest.id,
        attachmentCount,
      };
    });

    summaries.sort((a, b) => compareIso(a.lastDate, b.lastDate, params.sortDirection));
    const sliced = summaries.slice(params.offset, params.offset + params.limit);
    return { items: sliced, total: summaries.length };
  }

  private getLatestEmail(folderId: string): unknown | null {
    const row = this.queryEmailRows(folderId, "").sort((a, b) => compareIso(a.date, b.date, "DESC"))[0];
    return row ? this.getEmailById(row.id) : null;
  }

  private getEmailById(id: string): unknown | null {
    const row = this.one<EmailRow>(`SELECT * FROM emails WHERE id = ? LIMIT 1`, id);
    if (!row) return null;
    return this.hydrateEmail(row);
  }

  private getThread(threadId: string): { threadId: string; items: unknown[] } {
    const rows = this.all<EmailRow>(`SELECT * FROM emails WHERE thread_id = ? ORDER BY date ASC`, threadId);
    return {
      threadId,
      items: rows.map((row) => this.hydrateEmail(row)),
    };
  }

  private async serveAttachment(id: string): Promise<Response> {
    const record = this.one<StoredAttachmentRecord>(`SELECT * FROM attachments WHERE id = ? LIMIT 1`, id);
    if (!record) return notFound("attachment not found");

    const object = await this.env.BUCKET.get(record.r2_key);
    if (!object || !object.body) return notFound("attachment body missing");

    return new Response(object.body, {
      headers: {
        "content-type": record.mimetype,
        "content-disposition": `${record.disposition === "inline" ? "inline" : "attachment"}; filename="${safeFilename(record.filename)}"`,
        "content-length": String(record.size),
      },
    });
  }

  private ensureOutboundEnabled(): void {
    if (!hasOutboundEmailBinding(this.env)) {
      const error = new Error("outbound email is not configured; add an EMAIL send_email binding after deployment");
      (error as Error & { status?: number }).status = 501;
      throw error;
    }
  }

  private async sendNew(mailboxId: string, body: SendRequestBody): Promise<Record<string, unknown>> {
    this.ensureOutboundEnabled();
    if (!body.subject?.trim()) {
      throw new Error("subject is required");
    }
    const cleanedAttachments = (body.attachments ?? []).map(sanitizeAttachmentInput);
    const messageId = makeMessageId(mailboxId);
    const threadId = normalizeMessageId(messageId);
    const now = new Date().toISOString();
    const textBody = body.text ?? stripHtml(body.html ?? "");
    const htmlBody = body.html ?? `<pre>${escapeHtml(textBody)}</pre>`;

    const provider = await this.env.EMAIL!.send({
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      from: formatAddress(mailboxId, body.fromName),
      replyTo: body.replyTo,
      subject: body.subject,
      text: textBody,
      html: htmlBody,
      attachments: cleanedAttachments.map((item) => ({
        content: item.contentBase64,
        filename: item.filename,
        type: item.type,
        disposition: item.disposition ?? "attachment",
        contentId: item.contentId,
      })),
      headers: {
        "Message-ID": `<${messageId}>`,
      },
    });

    const emailId = crypto.randomUUID();
    this.insertEmail({
      id: emailId,
      folderId: "sent",
      subject: body.subject,
      sender: mailboxId,
      recipient: ensureArray(body.to).join(", "),
      cc: ensureArray(body.cc).join(", ") || null,
      bcc: ensureArray(body.bcc).join(", ") || null,
      date: now,
      read: 1,
      bodyText: textBody,
      bodyHtml: htmlBody,
      snippet: buildSnippet(textBody, htmlBody),
      normalizedSubject: normalizeSubject(body.subject),
      participants: buildParticipants(mailboxId, ensureArray(body.to).join(", "), ensureArray(body.cc).join(", "), ensureArray(body.bcc).join(", ")),
      inReplyTo: null,
      references: null,
      threadId,
      messageId,
      rawHeaders: JSON.stringify({ "message-id": `<${messageId}>` }),
    });
    await this.storeAttachments(emailId, cleanedAttachments);

    return {
      ok: true,
      emailId,
      threadId,
      messageId,
      providerMessageId: provider.messageId,
    };
  }

  private async reply(mailboxId: string, body: ReplyRequestBody): Promise<Record<string, unknown>> {
    this.ensureOutboundEnabled();
    const original = this.one<EmailRow>(`SELECT * FROM emails WHERE id = ? LIMIT 1`, body.originalEmailId);
    if (!original) throw new Error("original email not found");

    const toList = body.replyAll
      ? uniqueAddresses([
          original.sender,
          original.recipient,
          original.cc,
        ]).filter((addr) => normalizeEmail(addr) !== normalizeEmail(mailboxId))
      : uniqueAddresses([original.sender]);

    if (toList.length === 0) throw new Error("no valid recipients for reply");

    const originalMessageId = normalizeMessageId(original.message_id);
    const originalRefs = parseReferences(original.email_references);
    const referenceChain = [...new Set([...originalRefs, originalMessageId].filter(Boolean))];
    const messageId = makeMessageId(mailboxId);
    const threadId = original.thread_id || originalMessageId || normalizeMessageId(messageId);
    const subject = ensureReplySubject(original.subject ?? "(no subject)");
    const replyText = body.text ?? "";
    const originalQuote = buildReplyQuoteText(original);
    const textBody = [replyText.trim(), originalQuote].filter(Boolean).join("\n\n");
    const htmlBody = body.html
      ? `${body.html}<hr />${buildReplyQuoteHtml(original)}`
      : `<p>${escapeHtml(replyText).replace(/\n/g, "<br />")}</p><hr />${buildReplyQuoteHtml(original)}`;
    const cleanedAttachments = (body.attachments ?? []).map(sanitizeAttachmentInput);
    const now = new Date().toISOString();

    const provider = await this.env.EMAIL!.send({
      to: toList,
      from: formatAddress(mailboxId, body.fromName),
      subject,
      text: textBody,
      html: htmlBody,
      attachments: cleanedAttachments.map((item) => ({
        content: item.contentBase64,
        filename: item.filename,
        type: item.type,
        disposition: item.disposition ?? "attachment",
        contentId: item.contentId,
      })),
      headers: {
        "Message-ID": `<${messageId}>`,
        "In-Reply-To": `<${originalMessageId}>`,
        References: referenceChain.map((item) => `<${item}>`).join(" "),
      },
    });

    const emailId = crypto.randomUUID();
    this.insertEmail({
      id: emailId,
      folderId: "sent",
      subject,
      sender: mailboxId,
      recipient: toList.join(", "),
      cc: null,
      bcc: null,
      date: now,
      read: 1,
      bodyText: textBody,
      bodyHtml: htmlBody,
      snippet: buildSnippet(replyText, htmlBody),
      normalizedSubject: normalizeSubject(subject),
      participants: buildParticipants(mailboxId, toList.join(", ")),
      inReplyTo: originalMessageId,
      references: referenceChain.join(" "),
      threadId,
      messageId,
      rawHeaders: JSON.stringify({
        "message-id": `<${messageId}>`,
        "in-reply-to": `<${originalMessageId}>`,
        references: referenceChain.map((item) => `<${item}>`).join(" "),
      }),
    });
    await this.storeAttachments(emailId, cleanedAttachments);

    return {
      ok: true,
      emailId,
      threadId,
      messageId,
      providerMessageId: provider.messageId,
    };
  }

  private async forward(mailboxId: string, body: ForwardRequestBody): Promise<Record<string, unknown>> {
    this.ensureOutboundEnabled();
    const original = this.one<EmailRow>(`SELECT * FROM emails WHERE id = ? LIMIT 1`, body.originalEmailId);
    if (!original) throw new Error("original email not found");

    const originalAttachments = body.includeOriginalAttachments === false
      ? []
      : await this.loadAttachmentsForSend(body.originalEmailId);
    const extraAttachments = (body.attachments ?? []).map(sanitizeAttachmentInput).map((item) => ({
      content: item.contentBase64,
      filename: item.filename,
      type: item.type,
      disposition: item.disposition ?? "attachment",
      contentId: item.contentId,
    }));
    const attachments = [...originalAttachments, ...extraAttachments];

    const subject = body.subject?.trim() || ensureForwardSubject(original.subject ?? "(no subject)");
    const introText = body.introText?.trim() || "";
    const introHtml = body.introHtml?.trim() || `<p>${escapeHtml(introText).replace(/\n/g, "<br />")}</p>`;
    const forwardedText = buildForwardText(original, introText);
    const forwardedHtml = `${introHtml}<hr />${buildForwardHtml(original)}`;
    const messageId = makeMessageId(mailboxId);
    const threadId = normalizeMessageId(messageId);
    const now = new Date().toISOString();

    const provider = await this.env.EMAIL!.send({
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      from: formatAddress(mailboxId, body.fromName),
      subject,
      text: forwardedText,
      html: forwardedHtml,
      attachments,
      headers: {
        "Message-ID": `<${messageId}>`,
      },
    });

    const emailId = crypto.randomUUID();
    this.insertEmail({
      id: emailId,
      folderId: "sent",
      subject,
      sender: mailboxId,
      recipient: ensureArray(body.to).join(", "),
      cc: ensureArray(body.cc).join(", ") || null,
      bcc: ensureArray(body.bcc).join(", ") || null,
      date: now,
      read: 1,
      bodyText: forwardedText,
      bodyHtml: forwardedHtml,
      snippet: buildSnippet(forwardedText, forwardedHtml),
      normalizedSubject: normalizeSubject(subject),
      participants: buildParticipants(mailboxId, ensureArray(body.to).join(", "), ensureArray(body.cc).join(", "), ensureArray(body.bcc).join(", ")),
      inReplyTo: null,
      references: null,
      threadId,
      messageId,
      rawHeaders: JSON.stringify({ "message-id": `<${messageId}>` }),
    });

    const persistedAttachments: StoredAttachmentInput[] = [];
    for (const item of attachments) {
      const contentBase64 = typeof item.content === "string" ? item.content : toBase64(item.content);
      persistedAttachments.push({
        filename: item.filename,
        type: item.type,
        disposition: item.disposition,
        contentId: item.contentId,
        contentBase64,
      });
    }
    await this.storeAttachments(emailId, persistedAttachments);

    return {
      ok: true,
      emailId,
      threadId,
      messageId,
      providerMessageId: provider.messageId,
    };
  }

  private async clearFolder(folderId: string): Promise<number> {
    const attachmentRows = this.all<StoredAttachmentRecord>(
      `SELECT attachments.* FROM attachments JOIN emails ON attachments.email_id = emails.id WHERE emails.folder_id = ?`,
      folderId,
    );
    if (attachmentRows.length > 0) {
      await this.env.BUCKET.delete(attachmentRows.map((row) => row.r2_key));
    }
    const emails = this.all<{ id: string }>(`SELECT id FROM emails WHERE folder_id = ?`, folderId);
    this.sql.exec(`DELETE FROM emails WHERE folder_id = ?`, folderId);
    return emails.length;
  }

  private resolveThreadId(params: {
    normalizedSubject: string;
    participants: string;
    inReplyTo?: string | null;
    references?: string | null;
    messageId: string;
    date: string;
  }): string {
    const refs = parseReferences(params.references);
    if (refs.length > 0) {
      const refRow = this.one<{ thread_id: string | null }>(
        `SELECT thread_id FROM emails WHERE message_id = ? LIMIT 1`,
        refs[0],
      );
      return refRow?.thread_id || refs[0];
    }

    const inReplyTo = normalizeMessageId(params.inReplyTo);
    if (inReplyTo) {
      const replyRow = this.one<{ thread_id: string | null }>(
        `SELECT thread_id FROM emails WHERE message_id = ? LIMIT 1`,
        inReplyTo,
      );
      return replyRow?.thread_id || inReplyTo;
    }

    if (params.normalizedSubject) {
      const cutoff = new Date(new Date(params.date).getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const candidates = this.all<{ thread_id: string | null; participants: string | null }>(
        `SELECT thread_id, participants FROM emails WHERE normalized_subject = ? AND date >= ? ORDER BY date DESC LIMIT 20`,
        params.normalizedSubject,
        cutoff,
      );
      for (const candidate of candidates) {
        if (candidate.thread_id && participantsOverlap(candidate.participants ?? "", params.participants)) {
          return candidate.thread_id;
        }
      }
    }

    return normalizeMessageId(params.messageId) || crypto.randomUUID();
  }

  private insertEmail(record: {
    id: string;
    folderId: string;
    subject: string;
    sender: string;
    recipient: string;
    cc: string | null;
    bcc: string | null;
    date: string;
    read: number;
    bodyText: string;
    bodyHtml: string;
    snippet: string;
    normalizedSubject: string;
    participants: string;
    inReplyTo: string | null;
    references: string | null;
    threadId: string;
    messageId: string;
    rawHeaders: string;
  }): void {
    this.sql.exec(
      `INSERT INTO emails (
        id, folder_id, subject, sender, recipient, cc, bcc, date, read, starred,
        body_text, body_html, snippet, normalized_subject, participants,
        in_reply_to, email_references, thread_id, message_id, raw_headers
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.folderId,
      record.subject,
      record.sender,
      record.recipient,
      record.cc,
      record.bcc,
      record.date,
      record.read,
      record.bodyText,
      record.bodyHtml,
      record.snippet,
      record.normalizedSubject,
      record.participants,
      record.inReplyTo,
      record.references,
      record.threadId,
      record.messageId,
      record.rawHeaders,
    );
  }

  private async storeAttachments(emailId: string, attachments: StoredAttachmentInput[]): Promise<void> {
    for (const rawAttachment of attachments) {
      const attachment = sanitizeAttachmentInput(rawAttachment);
      const bytes = fromBase64(attachment.contentBase64);
      const attachmentId = crypto.randomUUID();
      const r2Key = `attachments/${emailId}/${attachmentId}/${safeFilename(attachment.filename)}`;
      await this.env.BUCKET.put(r2Key, bytes, {
        httpMetadata: { contentType: attachment.type },
        customMetadata: {
          emailId,
          attachmentId,
        },
      });
      this.sql.exec(
        `INSERT INTO attachments (id, email_id, r2_key, filename, mimetype, size, content_id, disposition)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        attachmentId,
        emailId,
        r2Key,
        attachment.filename,
        attachment.type,
        attachment.size ?? bytes.byteLength,
        attachment.contentId ?? null,
        attachment.disposition ?? "attachment",
      );
    }
  }

  private async loadAttachmentsForSend(emailId: string): Promise<Array<{ content: string; filename: string; type: string; disposition: "attachment" | "inline"; contentId?: string }>> {
    const records = this.listAttachments(emailId);
    const result: Array<{ content: string; filename: string; type: string; disposition: "attachment" | "inline"; contentId?: string }> = [];

    for (const record of records) {
      const object = await this.env.BUCKET.get(record.r2_key);
      if (!object?.body) continue;
      const arrayBuffer = await new Response(object.body).arrayBuffer();
      result.push({
        content: toBase64(arrayBuffer),
        filename: record.filename,
        type: record.mimetype,
        disposition: record.disposition === "inline" ? "inline" : "attachment",
        contentId: record.content_id ?? undefined,
      });
    }
    return result;
  }

  private queryEmailRows(folderId: string, q: string): EmailRow[] {
    const rows = folderId === "all"
      ? this.all<EmailRow>(`SELECT * FROM emails`)
      : this.all<EmailRow>(`SELECT * FROM emails WHERE folder_id = ?`, folderId);

    if (!q) return rows;
    const needle = q.toLowerCase();
    return rows.filter((row) => {
      const haystack = [
        row.subject,
        row.sender,
        row.recipient,
        row.cc,
        row.bcc,
        row.body_text,
        row.body_html,
        row.snippet,
      ]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }

  private hydrateEmail(row: EmailRow): Record<string, unknown> {
    return {
      id: row.id,
      folderId: row.folder_id,
      subject: row.subject ?? "(no subject)",
      from: row.sender ?? "",
      to: row.recipient ?? "",
      cc: row.cc ?? "",
      bcc: row.bcc ?? "",
      date: row.date,
      read: Boolean(row.read),
      starred: Boolean(row.starred),
      text: row.body_text ?? "",
      html: row.body_html ?? "",
      snippet: row.snippet ?? "",
      threadId: row.thread_id ?? row.id,
      messageId: row.message_id ?? "",
      inReplyTo: row.in_reply_to ?? "",
      references: row.email_references ?? "",
      attachments: this.listAttachments(row.id).map((item) => ({
        id: item.id,
        filename: item.filename,
        mimeType: item.mimetype,
        size: item.size,
        contentId: item.content_id,
        disposition: item.disposition,
        downloadPath: `/api/attachments/${encodeURIComponent(item.id)}`,
      })),
      rawHeaders: row.raw_headers ? safeJsonParse(row.raw_headers) : null,
    };
  }

  private toListSummary(row: EmailRow): ListSummary {
    return {
      id: row.id,
      folderId: row.folder_id,
      subject: row.subject ?? "(no subject)",
      sender: row.sender ?? "",
      recipient: row.recipient ?? "",
      date: row.date,
      read: Boolean(row.read),
      starred: Boolean(row.starred),
      snippet: row.snippet ?? "",
      threadId: row.thread_id ?? row.id,
      messageId: row.message_id ?? "",
      attachmentCount: this.countAttachments(row.id),
    };
  }

  private countAttachments(emailId: string): number {
    const row = this.one<{ count: number }>(`SELECT COUNT(*) AS count FROM attachments WHERE email_id = ?`, emailId);
    return Number(row?.count ?? 0);
  }

  private listAttachments(emailId: string): StoredAttachmentRecord[] {
    return this.all<StoredAttachmentRecord>(`SELECT * FROM attachments WHERE email_id = ? ORDER BY filename ASC`, emailId);
  }

  private all<T extends object>(query: string, ...bindings: unknown[]): T[] {
    return [...this.sql.exec<T>(query, ...bindings)];
  }

  private one<T extends object>(query: string, ...bindings: unknown[]): T | null {
    const rows = this.all<T>(query, ...bindings);
    return rows[0] ?? null;
  }
}

function clampNumber(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeSortColumn(value: string | null): "date" | "subject" | "sender" {
  return value === "subject" || value === "sender" ? value : "date";
}

function normalizeSortDirection(value: string | null): "ASC" | "DESC" {
  return String(value ?? "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";
}

function compareIso(left: string, right: string, direction: "ASC" | "DESC"): number {
  if (left === right) return 0;
  const result = left < right ? -1 : 1;
  return direction === "ASC" ? result : -result;
}

function compareString(left: string, right: string, direction: "ASC" | "DESC"): number {
  const result = left.localeCompare(right);
  return direction === "ASC" ? result : -result;
}

function compareEmailRows(
  left: EmailRow,
  right: EmailRow,
  sortColumn: "date" | "subject" | "sender",
  sortDirection: "ASC" | "DESC",
): number {
  if (sortColumn === "subject") {
    return compareString(left.subject ?? "", right.subject ?? "", sortDirection) || compareIso(left.date, right.date, "DESC");
  }
  if (sortColumn === "sender") {
    return compareString(left.sender ?? "", right.sender ?? "", sortDirection) || compareIso(left.date, right.date, "DESC");
  }
  return compareIso(left.date, right.date, sortDirection);
}

function ensureReplySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function ensureForwardSubject(subject: string): string {
  return /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`;
}

function uniqueAddresses(values: Array<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const value of values) {
    for (const token of String(value ?? "").split(",")) {
      const trimmed = token.trim();
      if (trimmed) set.add(trimmed);
    }
  }
  return [...set];
}

function buildReplyQuoteText(original: EmailRow): string {
  const date = original.date;
  const from = original.sender ?? "";
  const body = original.body_text?.trim() || stripHtml(original.body_html ?? "");
  return `On ${date}, ${from} wrote:\n> ${body.replace(/\n/g, "\n> ")}`;
}

function buildReplyQuoteHtml(original: EmailRow): string {
  const header = `<p>On ${escapeHtml(original.date)}, ${escapeHtml(original.sender ?? "")} wrote:</p>`;
  const originalHtml = original.body_html?.trim() || `<pre>${escapeHtml(original.body_text ?? "")}</pre>`;
  return `${header}<blockquote>${originalHtml}</blockquote>`;
}

function buildForwardText(original: EmailRow, introText: string): string {
  const lines = [
    introText,
    "---------- Forwarded message ---------",
    `From: ${original.sender ?? ""}`,
    `Date: ${original.date}`,
    `Subject: ${original.subject ?? "(no subject)"}`,
    `To: ${original.recipient ?? ""}`,
    original.cc ? `Cc: ${original.cc}` : "",
    "",
    original.body_text?.trim() || stripHtml(original.body_html ?? ""),
  ].filter(Boolean);
  return lines.join("\n");
}

function buildForwardHtml(original: EmailRow): string {
  const rows = [
    [`From`, original.sender ?? ""],
    [`Date`, original.date],
    [`Subject`, original.subject ?? "(no subject)"],
    [`To`, original.recipient ?? ""],
    original.cc ? [`Cc`, original.cc] : null,
  ].filter(Boolean) as Array<[string, string]>;
  const meta = rows
    .map(([label, value]) => `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`)
    .join("");
  const originalHtml = original.body_html?.trim() || `<pre>${escapeHtml(original.body_text ?? "")}</pre>`;
  return `<p>---------- Forwarded message ---------</p>${meta}<blockquote>${originalHtml}</blockquote>`;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
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
