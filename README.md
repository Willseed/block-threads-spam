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

## 應用程式登入

Production 預設以 Cloudflare Access 作為應用身分層。Worker 會自行驗證 `Cf-Access-Jwt-Assertion` 的 RS256 簽章、issuer 與 audience；只把不可變 `sub` 當成使用者識別。部署時必須設定：

- `TEAM_DOMAIN`：例如 `https://your-team.cloudflareaccess.com`
- `POLICY_AUD`：Access Application Audience tag

若未設定或驗證失敗，所有受保護的 `/api/*` 都會 fail closed；`/api/health` 保持公開供平台健康檢查。

## 候選產生原則

`generateCandidateVariants` 只執行單步、受控的視覺字元、標點、編輯與前後綴變形。呼叫端必須設定或接受總量與每規則配額；輸出會保留規則及繁體中文理由，且不會包含正式帳號本身。

`assessProfileSimilarity` 彙整使用者名稱、顯示名稱、頭像衍生分數、簡介與外部連結，輸出低／中／高「審核優先級」。分數只供排序，不能建立封鎖批准。

## D1 資料庫

`migrations/` 定義使用者、租戶、Threads 連線、候選、證據、工作、批准、Live View handoff、排程及稽核資料。Repository 的讀寫都同時帶入伺服器推導的 tenant 與 membership 條件；D1 不保存 Threads 密碼、Cookie、browser storage state 或 Live View URL。

建立遠端 D1 後，請在部署環境把它綁定為 `DB`，再執行：

```sh
npx wrangler d1 migrations apply <database-name> --remote
```

測試環境使用 Workers Vitest integration 建立隔離的本機 D1 並自動套用 migration，不依賴遠端資料庫。

Wrangler 設定使用 automatic provisioning：首次 deploy 時會為只宣告 binding 的 `DB` 與 `EVIDENCE` 建立遠端資源並回寫資源識別；repo 不保存假的 UUID。正式部署前仍需逐一設定 `secrets.required`，並保持所有外部平台 feature flag 預設為 `false`。

目前可用的 tenant-scoped API：

- `GET /api/me`
- `GET|POST /api/connections`
- `GET|POST /api/connections/:connectionId/candidates`
- `POST /api/connections/:connectionId/candidates/generate`

人工候選端點只接受一個完整、合法的 Threads username；不提供搜尋字串、萬用字元或批次輸入。
產生端點只接受規則白名單、單規則配額與總配額；正式帳號一律從該 tenant 的 connection 記錄讀取。

`POST /api/connections/:connectionId/candidates/:candidateId/refresh` 一次只查一個既有候選，且只對已確認的 OAuth 連線開放。Durable Object 在內部解密 token 並呼叫官方 Profiles API；Worker 只收到縮減後的公開欄位，計算可解釋審核優先級並保存最小快照，token 不會穿過 RPC 回應。

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

## 狀態機

候選、工作與批准 transition 全部採明確白名單。封鎖執行中或 approval consuming 後若結果不明，只能進入 `needs_review`，不能回到可自動重試的狀態。對使用者的動作結果固定為「確認成功、已停止未執行、結果不明待複查」三類。

## Web 介面

React SPA 提供儀表板、候選帳號、活動紀錄、連線與設定五個主要區域。頁首固定顯示目前受保護帳號與連線狀態；候選頁只提供單一人工目標與有限規則快照，不提供全選或批次封鎖。

## 安全邊界

- Threads 密碼、雙重驗證碼、Cookie 或 Session 檔不會由應用表單收集。
- 候選分數只決定審核順序，不會自動觸發封鎖。
- 每次封鎖都必須綁定一個近期重新確認的完整目標，且結果不明時不得自動重試。
