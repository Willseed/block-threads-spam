---
type: Component Model
title: 自助式 Threads 防護元件模型
description: 定義多使用者網頁、GitHub Actions 部署平面、OAuth 與 Meta lifecycle、每帳號協調器及資料儲存的責任分工。
tags: [components, cloudflare, github-actions, meta-oauth, multi-tenant]
timestamp: "2026-07-20T12:00:00+08:00"
---
# 元件一覽

| 元件 | 類型 | 主要責任 | 不應持有或執行的事項 |
|---|---|---|---|
| 使用者瀏覽器 | 使用者端 | 登入本服務、前往 Meta OAuth、檢視候選、批准單一封鎖及必要時開啟 Live View | 不保存可匯出的 OAuth token 或 Live View capability；不取得其他租戶資料 |
| Web 應用介面 | 體驗層 | 提供登入、連線、候選、證據、封鎖確認與設定頁 | 不收集 Threads 密碼或雙重驗證碼 |
| 應用程式身分服務 | 身分層 | 驗證使用者、建立短期應用工作階段、支援再驗證 | 不等同 Threads 授權 |
| GitHub Actions | 部署平面 | 無 secrets 的 verify job 執行品質閘門；main-only deploy job 以暫存 `0600` file 上傳未啟用 version、套用 migration，再依每次 workflow run 唯一 tag 啟用 | 不持有使用者 Threads token；不使用 Global API Key；不把機密寫入輸出或 artifact |
| Cloudflare API Token | 部署憑證 | 只允許指定帳戶及部署所需的 Workers、D1、R2 操作 | 不作為 Worker runtime binding；不授予其他帳戶、帳單或使用者管理權限 |
| Cloudflare Worker | 控制平面 | 租戶授權、輸入驗證、資料查詢、工作啟動、證據代理與稽核 | 不把 Browser Run 暴露為任意網址瀏覽代理 |
| Threads OAuth adapter | 外部授權層 | 建立官方授權 URL、交換長效 token、取得平台身分 | 不接受密碼、Cookie 或跨連線 token |
| Meta lifecycle receiver | 系統入口 | 驗證 `signed_request`、處理解除授權與資料刪除、發出 receipt | 不接受 Access 使用者參數作為清理範圍；驗證前不查詢平台身分 |
| 每帳號 Durable Object | 協調層 | 以「使用者＋Threads 帳號」為單位序列化登入、掃描與封鎖，防止併發衝突 | 不跨帳號共用工作階段或鎖 |
| Cloudflare Workflows | 工作層 | 執行可恢復的多步掃描與封鎖工作，保存階段狀態 | 不在結果不確定時自動重做封鎖步驟 |
| Browser Run | 執行平面 | 提供遠端 Chrome、Live View、人機協作、頁面導航、截圖與單一封鎖操作 | 不自行擴張候選、保存長期密碼或繞過平台挑戰 |
| 候選產生器 | 邏輯元件 | 依正式帳號建立有限、可解釋的變形清單 | 不生成無上限排列組合或全站列舉 |
| 相似度評估器 | 邏輯元件 | 彙整名稱、顯示名稱、頭像、簡介與連結等訊號以排序 | 不自動宣告詐騙或產生封鎖批准 |
| D1 | 關聯資料層 | 保存使用者、連線帳號、候選、決策、工作、通知與稽核中繼資料 | 不保存明文 OAuth token、Threads 密碼或 Live View capability |
| Durable Object 儲存 | 敏感狀態層 | 保存每連線應用層加密的 OAuth token、被包裝資料金鑰與協調狀態 | 不允許跨租戶鍵值讀取 |
| R2 | 證據物件層 | 保存私有候選截圖、封鎖前後證據及必要診斷物件 | 不提供匿名公開網址 |
| Worker vars | 公開執行期設定層 | 保存 Access team origin、主 Application audience 與 feature flags | 不保存憑證、簽章金鑰或 token；變更後必須重新部署 |
| Workers Secrets | 執行期機密層 | 保存主加密金鑰、服務端簽章金鑰與 Meta App 機密 | 不保存 Cloudflare 部署 token；不保存每位使用者的明文 token |
| Cron Trigger | 排程入口 | 依低頻策略啟動已同意排程的帳號掃描 | 不啟動封鎖 |
| Turnstile 與速率限制 | 濫用防護 | 保護註冊、登入、連線建立與敏感動作端點 | 不取代使用者身分驗證或業務授權 |
| Threads | 外部平台 | 提供登入、個人檔案與封鎖介面 | 不受本系統控制，頁面與風控可能隨時改變 |

# 控制平面與執行平面

Worker、Durable Object 與 Workflows 組成控制平面。它們決定誰可以操作哪個 Threads 連線、候選範圍、目前工作階段是否有效，以及破壞性動作是否具備完整批准。

Browser Run 是可選人工執行平面。它只在 feature flag 與 provider 驗證通過後，接收已由控制平面限制的單一封鎖交接任務；OAuth 登入與官方 profile 查詢不依賴 Browser Run。

GitHub Actions 是獨立部署平面。verify job 不綁定 environment，也不取得部署 secrets。只有完整品質閘門成功後，明確限制 `refs/heads/main` 的 deploy job 才進入已設定 exact `main` 的 `production` environment，使用最小權限帳戶 token 呼叫 Cloudflare，並把 `APP_ORIGIN`、兩個 namespace／加密金鑰、Meta App ID 與 App Secret 共五項剩餘 runtime 值寫入 runner 暫存 `0600` secrets file。Access 的 `TEAM_DOMAIN` 與主 Application `POLICY_AUD` 是公開驗證識別資訊，版本化於 Worker vars，讓 review 與部署能驗證其精確值。secrets file 只供未啟用 version upload 使用，之後依序套用 D1 migration、按 `github-${sha}-${run_id}-${run_attempt}` 唯一 tag 啟用同一次 run 上傳的 version，最後無條件清除。部署 token 不得被寫入 secrets file、Worker 設定、前端 bundle、測試 fixture 或執行期環境。

Cloudflare 的 staged upload 需要 Worker service record 已存在；`versions upload` 不能建立全新的 Worker。但同名、無 binding 的 Hello World Worker 只是第一項前置條件，不能套用首次 `v1 new_sqlite_classes` Durable Object migration；實測會以 code `10211` 拒絕。首次初始化必須先精確建立或重用 D1／R2（只補缺少的資源），以明確 binding、停用 automatic provisioning 套用 D1 migrations，再以同一 `ConnectionCoordinator` class 與 migration、無 runtime secrets／assets／cron且預設回應 `503` 的 fail-closed bootstrap 執行一次正常 `wrangler deploy`。bootstrap 完成後立即由完整版本取代，後續仍走 `versions upload`、D1 migration check／apply、run-unique tag promotion；code `10211` 是已觀察到的失敗原因，不是新環境必須刻意重現的步驟。

Meta lifecycle receiver 是狹義系統控制入口。它不建立一般租戶 session，只在驗證 `signed_request` 後，以 Meta 平台使用者識別找出相符的 OAuth 連線。跨 tenant 查詢只能服務這個撤銷／刪除目的，不能讀取或回傳其他租戶資料。

# 每帳號隔離單位

同一位使用者可能連線多個 Threads 帳號。架構以「應用使用者 ID＋Threads 帳號 ID」作為最小隔離單位。每個隔離單位都有自己的：

* Durable Object 協調器。
* 加密 token 與金鑰版本。
* 正式帳號與候選規則。
* 掃描及封鎖工作鎖。
* R2 證據前綴。
* D1 授權條件與稽核範圍。

Meta 資料刪除可同時命中多個 tenant 中相同平台身分的誤重複連線；清理器逐連線執行，並保留不含平台識別、租戶內容或證據的最小 receipt 狀態。它不得級聯刪除應用 `users`、`tenants`、`memberships` 或同一租戶的其他 Threads 連線。

# 關鍵相依關係

* Threads 連線依賴 Meta 官方 OAuth，讓使用者在官方頁面處理登入和多因素驗證；Live View 僅是預設關閉的人工封鎖交接能力。
* Meta lifecycle callback 依賴精確的 Access bypass、`META_APP_SECRET` HMAC、`issued_at` future-skew 檢查、不可變刪除 cutoff 與 D1 receipt；任一驗證失敗都不得啟動清理。
* 封鎖依賴近期目標重新確認、封鎖前證據、可寫入稽核、有效且受限的人工交接工作階段，以及已驗證 provider。
* Durable Object 不可用時，同一帳號的登入、掃描與封鎖全部停止，避免失去序列化保護。
* R2 或 D1 不可用時，破壞性動作失敗關閉。
* 資料刪除嚴格依 Durable Object 撤銷、R2 物件刪除、D1 關聯資料清理的順序前進；失敗階段由 Cron 依 receipt 有界重試。

# Citations

[1] [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
[2] [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)
[3] [Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/)
[4] [Cloudflare D1](https://developers.cloudflare.com/d1/)
[5] [Cloudflare R2](https://developers.cloudflare.com/r2/)
[6] [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/)
