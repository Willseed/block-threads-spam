---
type: Architecture Decision Record
title: 自助式 Threads 防護架構決策
description: 記錄官方 OAuth、多租戶隔離、CI 部署、Meta lifecycle callback、有限候選與單一封鎖的核心決策。
tags: [adr, architecture, decisions, oauth, deployment, meta-lifecycle]
timestamp: "2026-07-20T12:00:00+08:00"
---
# 決策一：分離應用程式登入與 Threads 登入

**決策**：使用者先經 Cloudflare Access 登入本服務，再另外透過 Meta 官方 OAuth 授權 Threads。

**原因**：兩種身分具有不同權限與風險；應用登入不能冒充 Threads 授權。

**後果**：首次設定多一步，但 OAuth state、token 撤銷、帳號切換與稽核更清楚；Access 身分不能替代 Meta 平台身分。

# 決策二：Threads 憑證只由 Meta 官方頁面處理

**決策**：本服務不提供 Threads 帳密輸入欄，不接受 Cookie、Session 檔或瀏覽器 Profile 上傳；主要連線採官方 OAuth，Live View 只保留為預設關閉的人工封鎖交接。

**原因**：避免服務與營運者直接接觸使用者長期憑證，並讓使用者本人處理雙重驗證。

**後果**：新連線依賴 Meta OAuth 與固定 callback；Browser Run 不可用時仍可建立 OAuth 連線及執行官方 API 查詢，但不能使用人工封鎖交接。

# 決策三：每個 Threads 連線使用一個 Durable Object

**決策**：以「應用使用者＋Threads 連線」路由到固定 Durable Object。

**原因**：強制同一帳號的登入、掃描與封鎖序列化，並提供強一致協調狀態。

**後果**：需要明確的物件識別與資料遷移策略，但可大幅降低重複動作與 Session 混用。

# 決策四：OAuth token 採每連線應用層加密

**決策**：Threads 長效 token 以每連線獨立資料金鑰加密後保存於該連線的 Durable Object 儲存；資料金鑰再由 Workers Secret 中的主密鑰包裝。

**原因**：OAuth token 等同高敏感授權能力，不能只依賴一般資料庫存取控制，也不能讓明文穿過 Worker RPC。

**後果**：需管理金鑰版本、輪替與不可逆撤銷。

# 決策五：候選產生有限且可解釋

**決策**：只使用受控變形規則、人工目標與有上限的候選快照。

**原因**：避免大規模列舉、平台負載與無法解釋的誤判。

**後果**：無法保證找出所有冒用帳號，但可保持風險、成本與審核量可控。

# 決策六：相似度只排序，不自動批准

**決策**：任何分數都不能直接觸發封鎖。

**原因**：名稱、頭像或簡介相似可能有合理原因；誤封的責任與影響高。

**後果**：需要使用者介入，但保留人類判斷與可追溯責任鏈。

# 決策七：封鎖採單一目標、一次性批准

**決策**：每次封鎖只對一個完整帳號有效，並要求近期再驗證、最新證據與目標重新確認。

**原因**：防止批次誤封、前端重送與頁面目標切換。

**後果**：大量候選需要逐一處理；不提供全選封鎖。

# 決策八：Cron 只掃描，不封鎖

**決策**：背景排程只檢查、存證、排序與通知。

**原因**：排程無法理解冒用情境，也不應在使用者不在場時執行破壞性操作。

**後果**：高優先候選仍需使用者回到介面批准。

# 決策九：人工交接期間停用 Session Recording

**決策**：任何 Live View 人工交接都不啟用 Browser Run Session Recording；主要 OAuth 授權不經本服務 Browser Run。

**原因**：即使輸入欄可能遮罩，登入頁、導覽與事件仍屬不必要的敏感資料。

**後果**：登入失敗的除錯資訊較少，改以結構化狀態、關閉原因與使用者回報處理。

# 決策十：結果不明時不自動重試

**決策**：封鎖點擊後若無法確認結果，工作進入待人工複查。

**原因**：外部頁面動作缺乏可靠的冪等保證，自動重試可能造成錯誤操作。

**後果**：部分案件需要使用者直接檢查 Threads 封鎖清單或透過 Live View 複查。

# 決策十一：支援人員無法使用使用者 Session

**決策**：客服只能看去識別化狀態，沒有 Session 下載、解密或代操作能力。

**原因**：降低內部人員風險，維持「帳號本人使用自己的工作階段」原則。

**後果**：帳號連線問題必須由使用者本人重新登入，客服不能直接代修。

# 決策十二：GitHub Actions 使用最小權限帳戶 token

**決策**：部署使用限定單一 Cloudflare 帳戶及必要 Workers／D1／R2 操作的 API Token，不使用 Global API Key。無 secrets 的 verify job 先完成品質閘門；只有 `refs/heads/main` 可進入已設定 exact `main` 的 `production` environment。deploy job 以暫存 `0600` secrets file 上傳帶 `github-${sha}-${run_id}-${run_attempt}` 唯一 tag 的未啟用 version，成功套用 D1 migrations 後才依同一 workflow run tag 啟用，並無條件清除暫存檔。由於 staged upload 不能建立全新 Worker，dashboard 已一次性建立無 binding 的 `threads-variant-guard` Hello World Worker 作為 bootstrap。

**原因**：部署憑證與 Worker 執行期機密具有不同權限及生命週期；混用會讓程式漏洞擴張成 Cloudflare 帳戶管理權限。

**後果**：需要管理 GitHub environment、token 輪替、部署權限清單、既有 Worker bootstrap、向後相容 migration 與 version activation 復原；Cloudflare API Token 不得出現在 `.dev.vars`、Worker bindings、secrets file、前端 bundle、log 或 artifact。migration 失敗時未啟用 version 不接收流量；activation 失敗時由同一受保護 workflow 依包含 SHA、run ID 與 run attempt 的唯一 tag 安全重跑。Custom domain 與 Access mapping 不由 bootstrap 自動完成，必須另外驗證。

# 決策十三：Meta lifecycle 採精確公開路徑與應用層簽章

**決策**：只對 `/meta/threads/deauthorize`、`/meta/threads/data-deletion` 與不透明 receipt status 路徑設定精確 Cloudflare Access bypass。兩個 POST 必須在任何資料查詢前，以 `META_APP_SECRET` 驗證 `signed_request` 的 `HMAC-SHA256`、常數時間簽章與 `issued_at` future skew；歷史 `issued_at` 固定為不可變刪除 cutoff。

**原因**：Meta 伺服器沒有使用者 Access session，但整個 hostname bypass 會移除應用的主要邊界；HMAC 阻擋偽造，future-skew 檢查阻擋未來時間操弄，而不可變 cutoff 防止舊要求重送刪除之後的重新授權資料。

**後果**：公開入口必須有 body、method、content type 與速率限制，不記錄 raw `signed_request`；Access 設定與 Worker route 必須一起部署及驗證。

# 決策十四：資料刪除以狹義跨租戶清理與 receipt 協調

**決策**：驗證後只依 Meta 平台使用者識別查詢相符 `meta_oauth` 連線，即使分散於多個 tenant 也逐一清理，但只處理 receipt 的 `issued_at` cutoff 以前存在／授權的資料。每個連線依 Durable Object revoke、R2 delete、D1 delete 前進，receipt 固定範圍並由 Cron 有界重試未完成階段。Receipt 另保存 keyed subject digest tombstone，OAuth D1 stage 以 `oauth_attempts.created_at` Unix seconds 固定 authorization boundary 並做原子 gate，不以 callback handler 時間判定。這會拒絕 marker 前建立、marker 完成後才延遲送達的 callback 並清除 DO credential，同時允許 marker 後明確建立的新 attempt。

**原因**：先刪 D1 會失去 DO 與 R2 定位資料；把 callback 假裝成一般 tenant 使用者則無法安全處理跨 tenant 誤重複連線。receipt 讓 Meta 可查狀態，也提供冪等與復原 checkpoint。

**後果**：需要專用、不可任意查詢的 system repository 與最小 receipt／tombstone。狀態 URL 只能使用高熵不透明 code，且不揭露命中範圍或使用者資料。

# 決策十五：Meta 資料刪除不等同應用帳號刪除

**決策**：Meta lifecycle 清理不刪除 Cloudflare Access 使用者、應用 `users`、`tenants`、`memberships` 或不相符連線。刪除本服務帳號必須由另一個已驗證的使用者流程負責。

**原因**：Meta 平台使用者識別與 Access subject 是不同身分；provider callback 沒有權限決定整個應用帳號與其他資料的命運。

**後果**：目前「刪除本服務帳號」仍是明確缺口，不能以完成 Meta data deletion 對外宣稱已提供完整帳號刪除。

# 相關概念

* [系統總覽](../system-overview.md)
* [身分與多租戶](../architecture/identity-and-tenancy.md)
* [瀏覽器工作階段](../architecture/browser-session-architecture.md)
* [封鎖批准流程](../experience/block-approval-flow.md)
