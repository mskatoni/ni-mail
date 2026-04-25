# ni-mail

一個極簡的 Cloudflare Worker，用於接收私人域名郵件並提供 HTTP API 讀取。

無需資料庫、無需前端、無需 JWT，部署後即可通過 API 取得最新郵件內容。

## 特性

- 📨 通過 Cloudflare Email Routing 接收郵件
- 🗄️ 使用 KV 儲存，最多保留 50 封
- 🔑 API Key 鑑權
- 🌐 支持多個自定義域名（域名需托管在 Cloudflare）
- 📦 僅依賴 `postal-mime`，無其他依賴
- 🚫 附件只保留 metadata，不存 base64，避免撞 KV 25MB 限制

## 工作原理

```
外部郵件 → 你的域名 MX（Cloudflare Email Routing）
                  ↓ catch-all 轉發
         Cloudflare Worker（收信 + HTTP API）
                  ↓ 存儲
         Cloudflare KV（最近 50 封）
                  ↓ 讀取
         curl /latest → 自動化腳本
```

郵件到達後由 `postal-mime` 解析為結構化 JSON，通過帶鑑權的 HTTP API 按需讀取，無需輪詢、無需訂閱。

## 前置條件

- 域名已托管在 Cloudflare
- 已啟用 Cloudflare Email Routing

> ⚠️ 收信地址必須是托管在 Cloudflare 的真實域名（如 `user@yourdomain.com`），
> `*.workers.dev` 不支持 Email Routing，發往 workers.dev 地址的信不會被收到。

## 部署

### 方式一：Cloudflare 一鍵部署

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mskatoni/ni-mail)

點擊按鈕後，Cloudflare 會自動 Fork 此 repo 並完成代碼部署。

部署完成後，還需在控制台完成以下配置：

**1. 綁定 KV Namespace**

Cloudflare 控制台 → Workers & Pages → `ni-mail` → Settings → Bindings → 新增 KV Namespace：
- 名稱：`MAIL_KV`
- 選擇已建立的 KV namespace（若尚未建立，先到 Workers & Pages → KV → Create namespace）

**2. 設定 AUTH_KEY**

Settings → Variables and Secrets → 新增：
- 類型：**Secret（密鑰）**，不要選 Text（明文可見）
- 變數名稱：`AUTH_KEY`
- 值：自訂一個密碼

儲存後點 **Deploy** 讓設定生效。

**3. 設定 Email Routing**

Cloudflare 控制台 → 你的域名 → Email → Email Routing → Routing rules → Catch-all：
- Action：Send to Worker
- 選擇 `ni-mail`

---

### 方式二：本地 CLI 部署

```bash
git clone https://github.com/mskatoni/ni-mail.git
cd ni-mail
npm install

# 建立 KV Namespace
wrangler kv:namespace create MAIL_KV
```

複製輸出的 ID，在 Cloudflare 控制台綁定，或直接加進 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "MAIL_KV"
id = "你的 KV ID"
```

```bash
wrangler deploy
```

## 自定義域名（可選）

> 域名必須已托管在 Cloudflare，無需手動建立 DNS 記錄，Cloudflare 會自動處理並簽發 SSL。

在 `wrangler.toml` 中取消注釋，支持多個：

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
curl https://your-worker.workers.dev/latest \
  -H "X-Auth-Key: 你的密碼"
```

**成功回應（有郵件）**

```json
{
  "id": "7eb63a8d-1195-4124-9eb3-fb4c2673e90c",
  "receivedAt": "2026-03-22T10:28:01.506Z",
  "from": "[email protected]",
  "to": "[email protected]",
  "subject": "beta",
  "text": "beta\n\n",
  "html": "<div dir=\"ltr\">beta</div>\n\n",
  "attachments": []
}
```

**無郵件時（HTTP 404）**

```json
{ "error": "no mail" }
```

**鑑權失敗（HTTP 401）**

```json
{ "error": "unauthorized" }
```

## 常見問題

### error code: 1101

Worker 運行時拋出未捕獲異常，最常見原因是 **KV Namespace 沒有正確綁定**。

確認步驟：控制台 → Workers & Pages → `ni-mail` → Settings → Bindings，確認有一條：

| 類型 | 名稱 | 值 |
|---|---|---|
| KV Namespace | `MAIL_KV` | 你建立的 namespace |

如果是空的，重新新增並點 **Save** 後重新部署即可。

### AUTH_KEY 建議使用 Secret 而非 Text

Settings → Variables and Secrets 新增 `AUTH_KEY` 時，類型請選 **Secret（密鑰）**，不要選 Text（文本）。

- **Secret**：值加密儲存，部署後不可見，適合密碼類資訊
- **Text**：明文儲存，任何有控制台權限的人都能看到

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=mskatoni/ni-mail&type=Date)](https://star-history.com/#mskatoni/ni-mail&Date)

## 社區

<a href="https://v2ex.com"><img src="https://user-images.githubusercontent.com/80169337/122051970-cd075b80-ce02-11eb-9653-0b8702377727.png" width="24" height="24" alt="V2EX" /></a>&nbsp;
<a href="https://www.nodeseek.com/post-659586-1"><img src="https://github.com/user-attachments/assets/0c6db696-769c-4d79-997c-9bc014cc6895" width="24" height="24" alt="NodeSeek" /></a>&nbsp;

## License

Apache License 2.0
