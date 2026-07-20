# Threads Variant Guard

自助式 Threads 變形帳號防護服務。系統使用有限且可解釋的候選規則協助帳號本人審核疑似相似帳號；排程不會自動批准或執行封鎖。

## 本機開發

需求：Node.js 22.12 以上或 24 以上。

```sh
npm install
npm run dev
```

完整品質檢查：

```sh
npm run check
```

健康檢查位於 `GET /api/health`。

## GitHub Actions 部署

推送至 `main` 或在 `main` 手動啟動 `Deploy to Cloudflare` workflow 時，無機密的 `verify` job 會先執行 `npm ci` 與 `npm run check`。只有成功後，限制為 `main` 且綁定 `production` environment 的 `deploy` job 才能取得部署機密。該 environment 已設定只允許 exact `main`；同一時間只允許一個 production 部署，進行中的部署不會被後續 push 取消。第三方 Actions 固定到不可變 commit SHA，secret 值仍只來自 GitHub Actions secret store。

Repository Actions secrets 必須包含兩個 CI 認證：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

`CLOUDFLARE_API_TOKEN` 應使用只限目標帳戶的 Custom API Token，不可使用 Global API Key。此專案部署與 automatic provisioning 所需的 account permissions 為 `Workers Scripts: Edit`、`Account Settings: Read`、`D1: Edit` 與 `Workers R2 Storage: Edit`。目前 workflow 不管理 Cloudflare Access、DNS 或 custom domain，也不需要 KV、Workers Tail 或 zone-level Workers Routes 權限。

Cloudflare Access 的 `TEAM_DOMAIN` 與 `POLICY_AUD` 是公開的驗證識別資訊，正式值固定在 `wrangler.jsonc` 的 `vars`，不屬於憑證或 GitHub Secrets。若更換 Access team domain 或主 Application，必須同步更新該設定並重新部署。

另需將 `wrangler.jsonc` 的五個 runtime secrets 同名存入 Repository Actions secrets；workflow 只會把這些值送進 Cloudflare Workers Secrets，不會寫入原始碼或 Wrangler 設定：

- `APP_ORIGIN`
- `SESSION_ENCRYPTION_KEY`
- `COORDINATOR_NAMESPACE_KEY`
- `META_APP_ID`
- `META_APP_SECRET`

首次正式部署的資源初始化順序如下：

1. 建立名稱精確相符的 `threads-variant-guard` Worker record；但同名 Hello World Worker 只是第一項前置條件，不足以建立首次 Durable Object migration。
2. 啟用 R2 後，查核並精確重用既有 `threads-variant-guard-db` 與 `threads-variant-guard-evidence`；只建立實際缺少的資源，不可盲目重建或刪除 partial state。若較早的失敗 upload 已留下其中一項，也採相同原則處理。
3. 以暫時的明確 D1／R2 binding 並停用 automatic provisioning（`--no-experimental-provision`），套用或確認 D1 migrations `0001`–`0007`。
4. 以一次性的正常 `wrangler deploy` 套用 fail-closed bootstrap：使用同一個 `ConnectionCoordinator` class 與 `v1` migration、不帶 runtime secrets、assets 或 cron，且所有請求預設回應 `503`。bootstrap 只建立 DO migration 前置狀態，完成後立即由完整應用版本取代。
5. 確認上述七個 Actions secrets、版本化 Access 驗證設定、DO migration 與 D1／R2 binding 正確後，再啟動受保護 workflow。runner 以 `umask 077` 建立 `0600` 暫存 secrets file，job 無論成功或失敗都會清除。
6. `wrangler versions upload` 以包含 commit SHA、run ID 與 retry attempt 的唯一 tag 上傳尚未接收流量的完整 Worker 版本，同時把五個 runtime secrets 納入該版本；同一個 job 接著執行 `wrangler d1 migrations apply DB --remote`，套用任何待辦 migration 或確認沒有待辦項目。
7. migration 檢查成功後才以該次唯一 tag 執行 `wrangler versions deploy`，讓新版本接收 100% 流量。後續部署維持 `versions upload` → D1 migration check／apply → tag promotion；若 upload 或 migration 失敗，既有部署維持不變，修復後可安全重跑。

本帳戶曾在同名 Hello World Worker 上嘗試首次 `versions upload`，因 `v1 new_sqlite_classes` 尚未由正常 deploy 建立而收到 Cloudflare code `10211`；這是採用上述 bootstrap 的原因，不是新環境必須刻意重現的步驟。GitHub runner 是暫時環境，automatic provisioning 產生的資源識別不會回寫到 repository；遠端 binding 關係與實際資源名稱應在 Cloudflare dashboard 查核。Custom domain 與 Cloudflare Access Application 仍由 Cloudflare dashboard 管理。

## Meta lifecycle callbacks

正式站台只對下列 Meta 系統 callback 建立精確的 Cloudflare Access bypass：

- `POST https://spam.buy2330.cc/meta/threads/deauthorize`
- `POST https://spam.buy2330.cc/meta/threads/data-deletion`
- `GET https://spam.buy2330.cc/meta/threads/data-deletion/status/<confirmation-code>`

Cloudflare Zero Trust 應只為上述三個精確用途建立 Self-hosted Application path（若介面無法合併則拆成三個 Application），政策設為 `Bypass` / `Everyone`。不要 bypass 整個 hostname、整段 `/meta/threads/*`，也不要把 `https://spam.buy2330.cc/auth/threads/callback` 納入；一般 OAuth callback 與所有 `/api/*` 仍必須通過 Access。

兩個 POST 只接受單一、大小受限的 `application/x-www-form-urlencoded` `signed_request`。Worker 使用 `META_APP_SECRET` 驗證 HMAC-SHA256，驗證成功後才套用不保存原始 Meta ID 的 D1 速率限制，再以 `COORDINATOR_NAMESPACE_KEY` 建立冪等 request digest、不透明 confirmation code 與 subject-digest tombstone。有效要求會依 `issued_at` 作為不可變 cutoff，跨 personal tenant 清除完全相符且未在要求後重新授權的 Threads 連線；OAuth identity stage 另以 tombstone 做原子 gate，避免 callback 與 token exchange 交錯時寫回舊授權。清理順序為 Durable Object token 撤銷、R2 證據刪除、D1 連線資料刪除。Access 使用者、tenant 與 membership 不在此清理範圍。

Meta App Dashboard 使用：

- OAuth Redirect URL：`https://spam.buy2330.cc/auth/threads/callback`
- Deauthorize Callback URL：`https://spam.buy2330.cc/meta/threads/deauthorize`
- Data Deletion Request URL：`https://spam.buy2330.cc/meta/threads/data-deletion`

Data Deletion callback 會回傳 `url` 與 `confirmation_code`；狀態端點只公開 `pending` 或 `completed`，不公開 Meta user ID、tenant、連線數量或內部錯誤。未完成 receipt 由每小時 cron 以有界批次重試。

## 應用程式登入

Production 預設以 Cloudflare Access 作為應用身分層。Worker 會自行驗證 `Cf-Access-Jwt-Assertion` 的 RS256 簽章、issuer 與 audience；只把不可變 `sub` 當成使用者識別。下列公開驗證設定已版本化於 `wrangler.jsonc`：

- `TEAM_DOMAIN`：完整的 HTTPS Access team origin
- `POLICY_AUD`：保護主站的 Access Application Audience tag，不是 policy ID 或 lifecycle bypass Application 的 audience

若未設定或驗證失敗，所有受保護的 `/api/*` 都會 fail closed。Worker 內部的 `/api/health` 不要求 Access JWT，但目前整個 hostname 的 Access Application 仍會在邊界保護它；若未來要供匿名監控使用，必須另行評估並只對此路徑建立精確 bypass。

## 候選產生原則

`generateCandidateVariants` 只執行單步、受控的視覺字元、標點、編輯與前後綴變形。呼叫端必須設定或接受總量與每規則配額；輸出會保留規則及繁體中文理由，且不會包含正式帳號本身。

`assessProfileSimilarity` 彙整使用者名稱、顯示名稱、頭像衍生分數、簡介與外部連結，輸出低／中／高「審核優先級」。分數只供排序，不能建立封鎖批准。

## D1 資料庫

`migrations/` 定義使用者、租戶、Threads 連線、候選、證據、工作、批准、Live View handoff、排程及稽核資料。Repository 的讀寫都同時帶入伺服器推導的 tenant 與 membership 條件；D1 不保存 Threads 密碼、Cookie、browser storage state 或 Live View URL。

正式部署使用 `DB` binding；GitHub Actions 在未啟用的 Worker version 上傳後、正式啟用前執行：

```sh
npx wrangler d1 migrations apply DB --remote
```

測試環境使用 Workers Vitest integration 建立隔離的本機 D1 並自動套用 migration，不依賴遠端資料庫。

Wrangler 正式設定使用 automatic provisioning：只宣告 binding 的 `DB` 與 `EVIDENCE` 可在 upload 時建立遠端資源；但資源 provisioning 與首次 Durable Object migration 是兩個獨立步驟，`versions upload` 不能建立 `v1 new_sqlite_classes`。CI 的暫時 checkout 不會把資源識別回寫到 repo，因此 repo 不保存帳戶專屬或虛構 UUID；首次 bootstrap 必須先查核並明確重用任何 partial D1／R2 state。正式部署前仍需逐一設定 `secrets.required`，並保持所有外部平台 feature flag 預設為 `false`。

目前可用的 tenant-scoped API：

- `GET /api/me`
- `GET|POST /api/connections`
- `GET|POST /api/connections/:connectionId/candidates`
- `POST /api/connections/:connectionId/candidates/generate`

人工候選端點只接受一個完整、合法的 Threads username；不提供搜尋字串、萬用字元或批次輸入。
產生端點只接受規則白名單、單規則配額與總配額；正式帳號一律從該 tenant 的 connection 記錄讀取。

`POST /api/connections/:connectionId/candidates/:candidateId/refresh` 一次只查一個既有候選，且只對已確認的 OAuth 連線開放。Durable Object 在內部解密 token 並呼叫官方 Profiles API；Worker 只收到縮減後的公開欄位，計算可解釋審核優先級並保存最小快照，token 不會穿過 RPC 回應。

`PATCH /api/connections/:connectionId/candidates/:candidateId` 只接受單一候選的 `watch`、`ignore` 或 `resume` 決定。伺服器用狀態機驗證轉移並以舊狀態作 compare-and-set，衝突會要求重新載入；每次成功決定都寫入 tenant-scoped 稽核。

`POST /api/connections/:connectionId/candidates/:candidateId/approvals` 需要近期再驗證、同一 Access session、已連線帳號、15 分鐘內的官方快照、完整 username 與平台 ID。批准固定綁定單一證據版本，五分鐘失效；只回傳一次的 action token 在 D1 僅保存 SHA-256，重複或狀態衝突不會簽發第二份有效批准。

Browser Live View 目前仍是 Beta，且無法硬性鎖定單一 Threads username；production 因此使用 fail-closed handoff provider。經部署環境整合驗證後，可注入 provider 使用 `POST /api/handoffs`：回應只包含安全 enter path，交換 token 放在 `HttpOnly` `__Host-` cookie；`POST .../enter` 原子消耗後才以 `303` 導向 `live.browser.run`。Live View URL、browser session ID 與 capability 不會進 JSON、前端 state 或稽核 metadata，重放一律拒絕。

使用者完成 Live View 人工操作後，只能呼叫 `POST /api/handoffs/:id/complete` 要求驗證；provider 介面沒有封鎖或重試方法。只有目標身分與 UI 都明確符合才記為 `confirmed_success`，其他情況一律把候選、批准與工作置為 `needs_review`，回傳 `unknown_needs_review`，同時關閉 browser session 並釋放帳號鎖。

`GET /api/capabilities` 只在兩個 handoff feature flag 皆開啟且已注入可用 provider 時回報人工操作可用；`automatedBlock` 永遠為 `false`。前端只在這時顯示單一候選的人工封鎖按鈕，經一次性批准後用原生 POST form 進入 broker，不讀取 redirect capability；返回後只提供「驗證結果」，不提供重試捷徑。

## Threads 個人檔案查詢

候選存在性與公開摘要採官方 `GET /profile_lookup?username=...` adapter，所需權限為 `threads_profile_discovery`。Adapter 只查一個已驗證的完整 username，並將 provider 結果縮減成 allowlist 欄位。權限不足、限流、回應格式變更或 target 不一致都會回傳明確的不可用分類；production 預設 adapter 不會降級成 Threads 網頁爬取。

Threads OAuth adapter 依序交換 authorization code、升級為長效 token，並以官方 `/me` 比對 exchange 回傳的 `user_id`。PKCE 目前未由 Threads 官方參數表文件化，因此不把它當成既有安全控制；實作改以強制單次 state、固定 redirect URI、confidential client 與立即交換保護流程。

`POST /api/connections/:connectionId/oauth/start` 需要近期應用身分驗證，並把一次性 state 綁定 tenant、使用者、連線、Access session 與固定 callback URI。`GET /auth/threads/callback` 會先原子消耗 state 才交換 token；成功後仍保持 `awaiting_identity_confirmation`，使用者必須以 `POST /api/connections/:connectionId/oauth/confirm` 精確確認官方 `/me` 回傳的帳號名稱。

## 私有證據

R2 bucket 綁定名稱為 `EVIDENCE`，不可啟用 public `r2.dev` 網址。證據限定 5 MiB 與 allowlist MIME，寫入時計算 SHA-256 並使用不可預測 key；D1 只保存索引。讀取與刪除每次都重新驗證 tenant membership，刪除後保留最小 tombstone 與稽核，不回傳任何 bucket public URL。

`GET|DELETE /api/evidence/:evidenceId` 需要近期應用身分再驗證。讀取回應固定為 `Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff` 與嚴格 CSP；跨租戶要求只回傳 404。

## 每連線協調器

`ConnectionCoordinator` 是 SQLite-backed Durable Object。控制平面以不可猜測 connection ID 路由，並另外綁定 owner digest。它持久化 lease generation、工作類型、逾時與 revocation version；同一 connection 同時只能有一個登入、掃描、人工接管或封鎖工作，撤銷後舊版本要求一律失效。

Threads 長效 token 只保存在該連線的 Durable Object 內，使用隨機 per-connection DEK 與 AES-GCM 加密，再由部署 secret 提供的 KEK 包裝。RPC 只回傳非機密的連線 metadata，不提供 token 匯出；中斷連線與 revoke 都會刪除密文及被包裝的 DEK。

`DELETE /api/connections/:connectionId` 需要近期再驗證與明確的 `dataRetention: retain|delete` 選擇。撤銷會先停用排程與舊工作，再由 Durable Object 提升 revocation version 並密碼學刪除憑證；選擇刪除時也會移除 R2 物件、候選與快照，D1 最後只保留必要 tombstone 與撤銷稽核。

## 狀態機

候選、工作與批准 transition 全部採明確白名單。封鎖執行中或 approval consuming 後若結果不明，只能進入 `needs_review`，不能回到可自動重試的狀態。對使用者的動作結果固定為「確認成功、已停止未執行、結果不明待複查」三類。

## Web 介面

React SPA 提供儀表板、候選帳號、活動紀錄、連線與設定五個主要區域。頁首固定顯示目前受保護帳號與連線狀態；候選頁只提供單一人工目標與有限規則快照，不提供全選或批次封鎖。

連線頁可直接啟動官方 Threads OAuth；callback 只回到乾淨的結果網址，前端重新載入伺服器已驗證的 `/me` 帳號後才顯示二次確認。候選頁一次只啟動一個官方 profile refresh，未連線時按鈕保持停用。

設定頁的中斷連線控制要求使用者在「保留案件紀錄」與「刪除候選及證據」之間明確選擇，並在提交前再次顯示完整受保護 username 與影響範圍。後端仍會要求近期再驗證；UI 確認不能取代伺服器授權。

`GET /api/activity` 最多回傳 100 筆目前 tenant 的最小稽核欄位；provider payload、內部 metadata、token、Cookie 與 Live View URL 一律不進入 API 回應。Web 活動頁預設載入最近 50 筆並以安全事件名稱呈現。

證據的 `retention_until` 是強制邊界：到期後即使 R2 清理尚未執行，讀取代理也會立即拒絕；每次 Cron 另以固定上限清除過期私有物件、寫入 tombstone 與最小稽核事件。

建立連線、OAuth 啟動、候選擴張與重新載入、封鎖能力簽發均套用 D1 固定視窗限制，範圍涵蓋使用者、租戶、Cloudflare 來源 IP 與連線。所有範圍先以部署祕密雜湊，資料庫不保存原始 IP；限流狀態由 Cron 有界清理，若限流儲存不可用則高風險要求失敗關閉。

Cloudflare 靜態資產由 `public/_headers` 套用同源 CSP、禁止 framing、無 referrer、最小瀏覽器權限與 HTML `no-store`；只有內容雜湊的 `/assets/*` 使用 immutable cache。這使 SPA 即使未經 Worker 路由，仍保有與 API 一致的瀏覽器端安全邊界。

`GET|PATCH /api/connections/:connectionId/schedule` 管理逐連線的低頻每日排程與 IANA 時區。新連線預設停用；只有已確認連線能啟用，撤銷會立即關閉並刪除偏好。排程偏好本身不能建立批准或封鎖工作。

Cron 每小時第 17 分鐘檢查到期排程；單次最多認領 10 個連線，每連線最多刷新 1 個候選。D1 lease 防止重複 dispatcher，Durable Object lease 防止同帳號併發；不存在帳號退避七天、限流退避一天。排程程式沒有批准或 handoff 呼叫路徑，`FEATURE_META_PROFILE_LOOKUP=false` 時完全不執行外部查詢。

## 安全邊界

- Threads 密碼、雙重驗證碼、Cookie 或 Session 檔不會由應用表單收集。
- 候選分數只決定審核順序，不會自動觸發封鎖。
- 每次封鎖都必須綁定一個近期重新確認的完整目標，且結果不明時不得自動重試。
