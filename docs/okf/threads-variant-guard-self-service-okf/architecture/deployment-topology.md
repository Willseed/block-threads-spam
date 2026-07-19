---
type: Deployment Topology
title: 自助式 Threads 防護部署拓樸
description: 劃分使用者、GitHub Actions 部署平面、Cloudflare 執行平面、Meta lifecycle callback 與 Threads 外部平台。
tags: [deployment, trust-boundary, cloudflare, github-actions, meta-lifecycle]
timestamp: "2026-07-20T12:00:00+08:00"
---
# 部署區域

## 區域 A：使用者裝置

使用者在自己的瀏覽器登入本服務，開啟候選與證據，並在敏感動作前完成再驗證。Threads 授權時，使用者前往 Meta 官方 OAuth 頁面；帳號密碼和雙重驗證資訊只由 Meta 處理。Live View 僅用於經驗證後開啟的人工封鎖交接。

## 區域 B：Web 使用者平面

靜態介面與應用路由由 Cloudflare 提供。此區域處理頁面顯示、Access 身分、租戶導覽及操作提交，但不提供可直接下載 OAuth token、被包裝金鑰或 Live View capability 的功能。

## 區域 C：控制與協調平面

Worker 驗證應用身分與租戶範圍；Durable Object 為每個已連線 Threads 帳號序列化狀態；Workflows 保存長流程的階段。控制平面是所有 Browser Run、D1、R2 與敏感狀態存取的唯一入口。

## 區域 D：瀏覽器執行平面

Browser Run 建立遠端 Chrome，只服務經部署驗證且 feature flag 開啟的人工封鎖交接。Live View 連結視同短期高敏感能力，不寫入一般日誌，也不提供給其他使用者或客服人員；OAuth 授權與 profile 掃描不進入此區域。

## 區域 E：資料平面

* D1：租戶、Threads 連線中繼資料、候選、決策與稽核。
* Durable Object 儲存：每連線加密 OAuth token、被包裝金鑰與協調狀態。
* R2：私有證據。
* Workers Secrets：主密鑰與服務機密。

## 區域 F：Meta 與 Threads 外部平台

Meta 掌控 OAuth、解除授權與資料刪除要求；Threads 掌控帳號資料、封鎖介面、安全挑戰與速率限制。一般 OAuth callback 維持使用者 Access session 綁定；Meta 伺服器發出的 lifecycle callback 則沒有該 session，必須走獨立的公開、簽章驗證邊界。

## 區域 G：GitHub Actions 部署平面

workflow 的 verify job 不綁定 `production` environment 或部署 secrets，先執行完整品質閘門。只有成功後，明確限制 `refs/heads/main` 的 deploy job 才進入已設定 exact `main` deployment branch 的 `production` environment，使用限定單一 Cloudflare 帳戶的 API Token，將 runtime secrets 放入 runner 暫存 `0600` file，上傳帶 `github-${sha}-${run_id}-${run_attempt}` 唯一 tag 的未啟用 Worker version，套用 D1 migrations，再依該 tag 啟用 version。workflow 預設只有 `contents: read`，不向 fork pull request 提供機密，不保存 CLI debug 輸出或含機密 artifact，並以 `always()` 清除暫存 secrets file。Cloudflare API Token 與帳戶識別只存在部署環境，不進入 Worker runtime。

`versions upload` 不會建立全新 Worker service record，因此同名 Worker record 是第一項前置條件；但無 binding 的 Hello World Worker 不能建立首次 `v1 new_sqlite_classes` migration，實測以 code `10211` 失敗。該次失敗 upload 已先建立 `threads-variant-guard-db` D1 database 與 `threads-variant-guard-evidence` R2 bucket；可重現的初始化流程應精確建立或重用這兩個目標、只補缺少的資源，以明確 binding 和停用 automatic provisioning 套用 D1 migrations `0001`–`0007`，再用同一 `ConnectionCoordinator` class／migration、無 runtime secrets／assets／cron且預設 `503` 的 fail-closed bootstrap 執行一次正常 `wrangler deploy`。bootstrap 隨後由完整應用取代；GitHub Actions run `29696901680` attempt 4 的 D1 步驟確認 `No migrations to apply`，再完成 tag promotion。`spam.buy2330.cc` 已掛載 Worker 並啟用 TLS；主 hostname 維持 Access 保護，只有三個 Meta lifecycle 用途採精確 bypass。

# 公開 Meta lifecycle 邊界

Cloudflare Access 只對下列精確用途設定 bypass，不對整個 hostname、`/api/*`、`/auth/*` 或其他 `/meta/*` 路徑放行：

* `POST /meta/threads/deauthorize`
* `POST /meta/threads/data-deletion`
* `GET /meta/threads/data-deletion/status/<opaque-receipt>`

前兩個 POST 只接受大小受限的表單 `signed_request`。Worker 在任何 D1、Durable Object 或 R2 操作前，先要求 `algorithm` 精確為 `HMAC-SHA256`，以 `META_APP_SECRET` 做常數時間 HMAC 比對，並拒絕位於允許 future skew 之外的 `issued_at`。歷史 `issued_at` 不以 max-age 拒絕，而是固定成不可變刪除 cutoff，避免同一要求重送時刪除其後重新授權建立的資料。狀態路徑只回傳 receipt 的粗粒度狀態，不回傳 Meta user ID、tenant、連線、證據或錯誤內情。

# 信任邊界

| 邊界 | 必要條件 | 主要風險 | 架構控制 |
|---|---|---|---|
| 公開網路 → Web 應用 | 有效應用身分、CSRF 防護與速率限制 | 帳號接管、機器註冊、請求偽造 | MFA 或 Passkey、Turnstile、短工作階段、SameSite Cookie、再驗證 |
| Web 應用 → 租戶資料 | 使用者與資料列的租戶 ID 必須一致 | 跨租戶讀寫 | 伺服器端授權、不可相信前端租戶參數、資料列級條件 |
| Worker → Durable Object | 由使用者與 Threads 連線衍生的固定物件識別 | 工作路由錯誤、狀態混用 | 伺服器端衍生識別、每帳號單一協調器、拒絕跨帳號操作 |
| Worker → Browser Run | 具體且受限的工作描述 | 任意瀏覽、Session 外洩、目標擴張 | Threads 網域允許清單、單次目標、短期 Live View、禁止通用代理 |
| Browser Run → Threads | 有效且限單一工作的人工交接 session | 平台風控、頁面變更、能力外洩 | provider 驗證、挑戰即停止、低頻工作、目標與結果重新確認 |
| Worker → R2／D1 | 正確租戶與案件範圍 | 證據外洩、稽核被竄改 | 私有儲存、代理讀取、不可預測物件鍵、寫入前授權 |
| 支援人員 → 生產系統 | 經核准的最小支援角色 | 內部人員濫用 | 不可查看或下載 Session、敏感操作雙人審核、完整管理稽核 |
| GitHub Actions → Cloudflare API | 無 secrets 的 verify job 成功、既有 Worker record 與首次 DO bootstrap、main-only deploy job、exact-main `production` environment、最小權限帳戶 token | 供應鏈竄改、token 外洩、錯誤帳戶部署、partial resource 誤刪、同 commit rerun tag 混淆或錯誤 version 啟用 | fail-closed 一次性 bootstrap、partial D1／R2 查核重用、workflow 最小權限、環境核准、固定 action 版本、run-unique tag activation、單一帳戶資源範圍、`0600` secrets file、always cleanup、機密遮罩與輪替 |
| Meta → lifecycle receiver | 精確 Access bypass、有效 `signed_request`、不超出 future skew 的 `issued_at` | 偽造撤銷、重放刪除、公開端點濫用 | HMAC 常數時間驗證、不可變刪除 cutoff、body／速率限制、receipt 冪等、最小回應 |
| lifecycle receiver → 跨租戶資料 | 已驗證 Meta 平台使用者識別、固定清理目的 | 權限擴張、刪除錯誤租戶 | 只查相符 `platform_user_id` 的 OAuth 連線、逐連線撤銷、禁止刪除 Access user／tenant／其他連線 |

# 網路方向

使用者主動連向本服務、Meta OAuth 與必要時的 Live View。GitHub Actions 主動連向 Cloudflare 部署 API；控制平面主動連向 Cloudflare 資料服務、Meta API 與 Browser Run；Meta 主動連向三個精確 lifecycle 路徑。D1、R2、Durable Object 儲存與 Workers Secrets 不向公開網路提供匿名管理入口。

# 相關概念

* [元件模型](../architecture/component-model.md)
* [安全架構](../security/security-architecture.md)
* [威脅模型](../security/threat-model.md)

# Citations

[1] [Cloudflare Live View](https://developers.cloudflare.com/browser-run/features/live-view/)
[2] [Cloudflare Human in the Loop](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/)
[3] [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
