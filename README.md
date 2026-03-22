# mail-worker

一個極簡的 Cloudflare Worker，用於接收域名郵件並提供 HTTP API 讀取。

無需資料庫、無需前端、無需 JWT，部署後即可通過 API 取得最新郵件內容。

## 特性

- 📨 通過 Cloudflare Email Routing 接收郵件
- 🗄️ 使用 KV 儲存，最多保留 50 封
- 🔑 API Key 鑑權
- 🌐 支持多個自定義域名（域名需托管在 Cloudflare）
- 📦 僅依賴 `postal-mime`，無其他依賴

## 前置條件

- 域名已托管在 Cloudflare
- 已啟用 Cloudflare Email Routing

## 部署

### 方式一：Cloudflare 一鍵部署

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/OWNER/REPO)

點擊按鈕後，Cloudflare 會自動 Fork 此 repo 並完成代碼部署。

部署完成後，還需手動完成以下兩步：

**1. 建立 KV Namespace 並綁定**

```bash
wrangler kv:namespace create MAIL_KV
```

複製輸出的 `id`，前往 Cloudflare 控制台 → Workers & Pages → 你的 worker → Settings → Bindings → 新增 KV Namespace，名稱填 `MAIL_KV`，選擇剛建立的 namespace。

**2. 設定環境變數**

Cloudflare 控制台 → Workers & Pages → 你的 worker → Settings → Variables → 新增：

| 變數名 | 值 |
|---|---|
| `AUTH_KEY` | 自訂一個密碼 |

---

### 方式二：本地 CLI 部署

**1. 安裝依賴**

```bash
npm install wrangler postal-mime
```

**2. 建立 KV Namespace**

```bash
wrangler kv:namespace create MAIL_KV
```

複製輸出的 `id`，填入 `wrangler.toml`。

**3. 配置 `wrangler.toml`**

```toml
[vars]
AUTH_KEY = "換成你的密碼"

[[kv_namespaces]]
binding = "MAIL_KV"
id = "貼上剛才的 KV ID"
```

**4. 部署**

```bash
wrangler deploy
```

**5. 設定 Email Routing**

Cloudflare 控制台 → Email → Email Routing → Catch-all rule → Action: Send to Worker → 選擇 `mail-worker`

## 自定義域名（可選）

> 域名必須已托管在 Cloudflare，無需手動建立 DNS 記錄，Cloudflare 會自動處理並簽發 SSL。

在 `wrangler.toml` 中取消注釋並填入你的子域名，支持多個：

```toml
[[routes]]
pattern = "mail.domain-a.com"
custom_domain = true

[[routes]]
pattern = "mail.domain-b.com"
custom_domain = true
```

重新部署後即可通過自定義域名訪問 API。多個域名收到的郵件共用同一個 inbox，`to` 欄位可用於區分來源域名。

## API

所有請求需帶上 Header：`X-Auth-Key: 你的密碼`

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/latest` | 取得最新一封完整郵件 |
| GET | `/mails?limit=10` | 取得最近 N 封郵件列表（不含正文） |
| GET | `/mail/:id` | 取得單封完整郵件（含 html/text） |
| DELETE | `/mails` | 清空收件匣 |

**範例**

```bash
# 使用自定義域名取得最新郵件
curl https://mail.yourdomain.com/latest \
  -H "X-Auth-Key: 你的密碼"

# 回應範例
{
  "id": "uuid-xxxx",
  "receivedAt": "2025-03-22T10:00:00.000Z",
  "from": "[email protected]",
  "to": "[email protected]",
  "subject": "驗證碼：123456",
  "text": "你的驗證碼是 123456",
  "html": "<p>你的驗證碼是 123456</p>",
  "attachments": [
    { "filename": "report.pdf", "mimeType": "application/pdf", "size": 102400 }
  ]
}
```

## License

Apache License 2.0
