export type SqlCursorRow = object;

export interface SqlStorage {
  exec<T extends SqlCursorRow = SqlCursorRow>(query: string, ...bindings: unknown[]): Iterable<T>;
}

export interface DurableObjectStateLike {
  storage: {
    sql: SqlStorage;
  };
  blockConcurrencyWhile<T>(callback: () => Promise<T> | T): Promise<T>;
}

export interface DurableObjectIdLike {
  toString(): string;
}

export interface DurableObjectStubLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespaceLike<T = unknown> {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface R2ObjectBodyLike {
  body: ReadableStream<Uint8Array> | null;
  size: number;
  httpMetadata?: {
    contentType?: string;
  };
}

export interface R2BucketLike {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: {
      httpMetadata?: {
        contentType?: string;
      };
      customMetadata?: Record<string, string>;
    },
  ): Promise<void>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  delete(keys: string | string[]): Promise<void>;
}

export interface EmailAttachment {
  content: string | ArrayBuffer;
  filename: string;
  type: string;
  disposition: "attachment" | "inline";
  contentId?: string;
}

export interface EmailSendMessage {
  to: string | string[];
  from: string | { email: string; name: string };
  subject: string;
  html?: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string | { email: string; name: string };
  attachments?: EmailAttachment[];
  headers?: Record<string, string>;
}

export interface EmailBindingLike {
  send(message: EmailSendMessage): Promise<{ messageId: string }>;
}

export interface Env {
  AUTH_KEY: string;
  DOMAINS: string;
  DEFAULT_MAILBOX?: string;
  MAILBOX: DurableObjectNamespaceLike;
  BUCKET: R2BucketLike;
  EMAIL?: EmailBindingLike;
}

export interface StoredAttachmentInput {
  filename: string;
  type: string;
  disposition?: "attachment" | "inline";
  contentId?: string;
  contentBase64: string;
  size?: number;
}

export interface StoredAttachmentRecord {
  id: string;
  email_id: string;
  r2_key: string;
  filename: string;
  mimetype: string;
  size: number;
  content_id: string | null;
  disposition: string | null;
}

export interface IncomingEmailPayload {
  id: string;
  folderId: string;
  from: string;
  to: string;
  cc?: string | null;
  bcc?: string | null;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  snippet: string;
  date: string;
  messageId: string;
  inReplyTo?: string | null;
  references?: string | null;
  rawHeaders: Record<string, string>;
  attachments: StoredAttachmentInput[];
}

export interface SendRequestBody {
  fromName?: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  attachments?: StoredAttachmentInput[];
}

export interface ReplyRequestBody {
  originalEmailId: string;
  fromName?: string;
  text?: string;
  html?: string;
  replyAll?: boolean;
  attachments?: StoredAttachmentInput[];
}

export interface ForwardRequestBody {
  originalEmailId: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  fromName?: string;
  subject?: string;
  introText?: string;
  introHtml?: string;
  includeOriginalAttachments?: boolean;
  attachments?: StoredAttachmentInput[];
}
