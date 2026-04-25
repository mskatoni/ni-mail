# ni-mail

一個極簡的 Cloudflare Worker，用於接收私人域名郵件並提供 HTTP API 讀取。

無需前端、無需 JWT，部署後即可通過 API 取得最新郵件內容。

## 特性

- 📨 通過 Cloudflare Email Routing 接收郵件
- 🗄️ 使用 Durable Objects + SQLite 儲存郵件 metadata，使用 R2 儲存附件內容
- 🔑 API Key 鑑權
- 🌐 支持多個自定義域名（域名需托管在 Cloudflare）
- 📦 保留原版極簡 API：`/latest`、`/mails`、`/mail/:id`
- 🧵 支持 threaded inbox、thread detail、附件下載
- ✉️ 可選支持 `send / reply / forward`（配置 `EMAIL` binding 後啟用）
- 🚫 未配置 `EMAIL` binding 時，收信與讀信 API 仍可正常工作

## 工作原理

```
外部郵件 → 你的域名 MX（Cloudflare Email Routing）
                  ↓ catch-all 轉發
         Cloudflare Worker（收信 + HTTP API）
                  ↓
         Mailbox Durable Object（每個 mailbox 一個）
                  ↓
         SQLite（郵件 metadata / thread） + R2（附件）
                  ↓
         curl /latest → 自動化腳本
```

郵件到達後由 `postal-mime` 解析為結構化 JSON，通過帶鑑權的 HTTP API 按需讀取。

## 前置條件

- 域名已托管在 Cloudflare
- 已啟用 Cloudflare Email Routing
- Node.js 20 或更高版本

> ⚠️ 收信地址必須是托管在 Cloudflare 的真實域名（如 `user@yourdomain.com`），
> `*.workers.dev` 不支持 Email Routing，發往 workers.dev 地址的信不會被收到。

## 部署

### 方式一：Cloudflare 一鍵部署

上傳到你自己的 GitHub 倉庫後，將下方按鈕中的 `<YOUR_USERNAME>/<YOUR_REPO>` 換成實際倉庫地址即可：

```markdown
[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/<YOUR_USERNAME>/<YOUR_REPO>)
```

Cloudflare Builds 建議配置：

- Root directory：留空或 `/`
- Build command：留空
- Deploy command：`npm run deploy`

部署完成後，還需在控制台完成以下配置：

**1. 設定 AUTH_KEY**

Settings → Variables and Secrets → 新增：

- 類型：**Secret（密鑰）**，不要選 Text（明文可見）
- 變數名稱：`AUTH_KEY`
- 值：自訂一個密碼

儲存後點 **Deploy** 讓設定生效。

**2. 設定可收信域名**

在 `wrangler.jsonc` 中設定你的域名：

```jsonc
{
  "vars": {
    "DOMAINS": "example.com,example.net"
  }
}
```

公開模板預設留空，方便任何 Cloudflare 帳號先完成第一次部署。

**3. 設定 Email Routing**

Cloudflare 控制台 → 你的域名 → Email → Email Routing → Routing rules → Catch-all：

- Action：Send to Worker
- 選擇 `ni-mail`

**4. （可選）啟用發信功能**

若你需要使用發信 / 回覆 / 轉發接口，請為 Worker 新增一個名為 `EMAIL` 的 `send_email` binding。

未配置 `EMAIL` binding 時，收信和讀信 API 仍可正常工作，只是發信接口會回 `501`。

---

### 方式二：本地 CLI 部署

```bash
git clone https://github.com/<YOUR_USERNAME>/<YOUR_REPO>.git
cd ni-mail
npm ci
npm run check:deploy
npm exec -- wrangler secret put AUTH_KEY
npm run deploy
```

如果你是本地部署，通常只需要：

1. 修改 `wrangler.jsonc` 中的：
   - `name`
   - `vars.DOMAINS`
   - `r2_buckets[*].bucket_name`
2. 在 Cloudflare 後台設置 `AUTH_KEY`
3. 配置 Email Routing 的 Send to Worker 規則

## 自定義域名（可選）

> 域名必須已托管在 Cloudflare，無需手動建立 DNS 記錄，Cloudflare 會自動處理並簽發 SSL。

首次部署成功後，可以在 Cloudflare 控制台為 Worker 添加 Custom Domain。

如需用 Wrangler 管理，在 `wrangler.jsonc` 中添加你自己的域名：

```jsonc
{
  "routes": [
    {
      "pattern": "mail.example.com",
      "custom_domain": true
    }
  ]
}
```

不要把不屬於部署者 Cloudflare 帳號的域名提交到公開模板中。

## API

所有請求需帶上 Header：`X-Auth-Key: 你的密碼`

### 與原版兼容的路由

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/latest?mailbox=user@example.com` | 取得最新一封完整郵件 |
| GET | `/mails?mailbox=user@example.com&limit=10` | 取得最近 N 封郵件列表（不含正文） |
| GET | `/mail/:id?mailbox=user@example.com` | 取得單封完整郵件（含 html/text） |
| DELETE | `/mails?mailbox=user@example.com&folder=inbox` | 清空收件匣 |

### 新增路由

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/mailboxes/:mailboxId/latest` | 讀取指定 mailbox 最新郵件 |
| GET | `/api/mailboxes/:mailboxId/emails` | 列表 / 搜索 / 排序 |
| GET | `/api/mailboxes/:mailboxId/emails/:id` | 讀取單封郵件 |
| POST | `/api/mailboxes/:mailboxId/emails/:id/read` | 標記已讀 |
| GET | `/api/mailboxes/:mailboxId/threads/:threadId` | 讀取整個 thread |
| GET | `/api/attachments/:attachmentId?mailbox=user@example.com` | 下載附件 |
| POST | `/api/mailboxes/:mailboxId/send` | 發新郵件（需 `EMAIL` binding） |
| POST | `/api/mailboxes/:mailboxId/reply` | 回覆郵件（需 `EMAIL` binding） |
| POST | `/api/mailboxes/:mailboxId/forward` | 轉發郵件（需 `EMAIL` binding） |

**範例**

```bash
curl "https://your-worker.workers.dev/latest?mailbox=user@example.com" \
  -H "X-Auth-Key: 你的密碼"
```

**無郵件時（HTTP 404）**

```json
{ "error": "no mail" }
```

**鑑權失敗（HTTP 401）**

```json
{ "error": "unauthorized" }
```

**未配置發信 binding 而調用發信接口時（HTTP 501）**

```json
{ "error": "outbound email is not configured; add an EMAIL send_email binding after deployment" }
```

## 常見問題

### error code: 1101

Worker 運行時拋出未捕獲異常，常見原因包括：

- `AUTH_KEY` 沒有設置
- Email Routing 沒有正確指到這個 Worker
- `DOMAINS` 沒有包含當前 mailbox 的域名
- R2 / Durable Object 綁定不完整

先確認：

- Worker 已成功部署
- `wrangler.jsonc` 中的 `MAILBOX` 與 `BUCKET` binding 存在
- 控制台裡 `AUTH_KEY` 已設為 Secret

### AUTH_KEY 建議使用 Secret 而非 Text

Settings → Variables and Secrets 新增 `AUTH_KEY` 時，類型請選 **Secret（密鑰）**，不要選 Text（文本）。

- **Secret**：值加密儲存，部署後不可見，適合密碼類資訊
- **Text**：明文儲存，任何有控制台權限的人都能看到

## License

Apache License 2.0
