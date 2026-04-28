declare module "postal-mime" {
  export interface PostalMimeAttachment {
    filename?: string;
    mimeType?: string;
    content?: ArrayBuffer | Uint8Array | string | null;
    contentId?: string | null;
    disposition?: string | null;
  }

  export interface PostalMimeResult {
    subject?: string | null;
    text?: string | null;
    html?: string | null;
    attachments?: PostalMimeAttachment[] | null;
  }

  export default class PostalMime {
    constructor(options?: Record<string, unknown>);
    parse(input: ArrayBuffer | Uint8Array | string): Promise<PostalMimeResult>;
  }
}

declare module "cloudflare:workers" {
  export class DurableObject {
    constructor(state: any, env: any);
  }
}
