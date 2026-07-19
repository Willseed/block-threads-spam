---
type: Session Architecture
title: Threads OAuth 憑證與人工瀏覽器工作階段架構
description: 描述官方 OAuth token 的建立、加密保存、使用、撤銷，以及預設關閉的 Live View 人工交接。
tags: [oauth, token-vault, live-view, revocation, encryption]
timestamp: "2026-07-19T12:00:00+08:00"
---
# 設計目標

* Threads 帳號密碼與雙重驗證資訊只由 Meta 官方頁面處理，不進入本服務的表單、資料庫或日誌。
* OAuth state 綁定 tenant、應用使用者、連線、Access session 與固定 callback，只能消耗一次。
* 保存的長效 token 以每連線資料金鑰加密，不能跨租戶或跨連線使用。
* 查詢只在該連線 Durable Object 內解密 token，使用後不把明文帶回 Worker 或前端。
* 只有工作階段擁有者能取得預設關閉的 Live View 人工交接能力。
* 使用者能自行更新或撤銷連線。

# 建立流程

1. 使用者在本服務完成近期再驗證並選擇「連線 Threads」。
2. 每連線 Durable Object 建立連線 lease，避免同一連線同時出現兩個授權流程。
3. Worker 建立高熵 state，將其雜湊與 tenant、使用者、連線、Access session、固定 callback、到期時間及 `oauth_attempts.created_at` 寫入 D1；`created_at` 的 Unix seconds 固定為這次授權的 authorization boundary。
4. 使用者前往 Meta 官方 Threads OAuth 頁面登入、完成雙重驗證並決定授權。
5. OAuth callback 先原子消耗 state，再以 confidential client 的 App Secret 交換短效與長效 token；D1 identity stage 使用 attempt-created boundary 對照 subject-digest tombstone，不使用 callback 到達或 handler 開始時間。
6. 系統以官方身分端點比對 exchange 回傳的 user ID，並要求使用者確認完整 username。
7. Durable Object 以每連線 DEK 加密長效 token，再由 Workers Secret 中的 KEK 包裝 DEK；只有原子 tombstone gate 通過才把平台識別、username、attempt-created boundary、連線狀態與版本 stage 到 D1。Gate 拒絕時清除剛寫入 Durable Object 的 credential。
8. callback 清除 code 與 state，導回不含 provider 機密的結果頁，並釋放連線 lease。

# Live View 人工交接保護

Live View 不用於主要 OAuth 登入，只能在人工封鎖能力經部署驗證且 feature flag 開啟時使用。連結等同短期遠端瀏覽器控制能力，因此：

* 只在連線頁面即時顯示，不以 Email、聊天訊息或一般通知傳送。
* 不寫入分析、錯誤追蹤、反向代理存取日誌或瀏覽器歷史建議資料。
* 只允許同一應用工作階段兌換一次；頁面離開或逾時後需重新取得。
* 登入期間禁止平台客服或系統管理者旁觀。
* 登入瀏覽器不啟用 Session Recording，避免收集不必要的鍵盤與頁面事件。

# 保存與加密

每個 Threads 連線使用獨立資料金鑰。資料金鑰由服務主密鑰封裝，主密鑰存於 Workers Secrets。token 密文與被包裝的資料金鑰保存於對應 Durable Object 的持久儲存；D1 保存平台識別、版本與健康狀態，但不保存 token。

加密物件應具備完整性驗證、金鑰版本、建立時間、最後成功使用時間與工作階段來源帳號。解密後若讀取到的 Threads 身分與連線紀錄不一致，系統立即失效該版本。

# 使用流程

官方 profile 查詢開始前，Durable Object 確認沒有衝突工作並解密目前有效 token；adapter 只處理一個已驗證的完整 username，且只回傳 allowlist 欄位。若啟用人工封鎖交接，Browser Run 使用獨立的一次性能力，不得匯出或混用 OAuth token。

# 失效與更新

下列情況將工作階段標記為需要重新連線：

* Meta API 回報 token 無效、撤銷或權限不足。
* 官方 `/me` 身分與已綁定帳號不一致。
* 密文完整性驗證失敗。
* 使用者在 Meta 官方介面解除 App 授權，或平台送達有效 deauthorization callback。
* 連續低風險健康檢查失敗。

系統不得保存使用者密碼來自動恢復；只能要求使用者重新完成 Meta 官方 OAuth。

# 撤銷

使用者選擇「中斷 Threads 連線」後：停止新排程、取消未開始工作、提升 revocation version、在 Durable Object 刪除 token 密文與被包裝的 DEK、關閉活動 Browser Run Session，並在 D1 保留最小必要的撤銷稽核。互動式中斷可依使用者選擇保留或刪除歷史證據。

有效 deauthorization 或 data-deletion callback 都進入 lifecycle receipt 驅動的完整清理流程；差異是只有 data-deletion 產生可對外查詢的 confirmation code。兩者都只處理 `issued_at` cutoff 前相符連線及其資料。

# Meta 資料刪除順序

資料刪除不能先移除 D1 的連線索引，否則可能失去定位 Durable Object 與 R2 證據的能力。每一個相符連線依序執行：

1. Durable Object 撤銷：提升版本、停止 lease、密碼學刪除 token 與 DEK。
2. R2 清理：依 D1 證據索引逐批刪除私有物件，以 `deleted_at` tombstone 保存可重試 checkpoint，不建立公開 URL。
3. D1 清理：刪除候選、snapshot、approval、handoff、schedule、OAuth attempt、證據索引及連線資料，只留下不含平台識別的最小 receipt／tombstone。

任一階段失敗都回到可重試的內部 `pending`，由 Cron 有界重試；處理期間為 `processing`，完成後為 `completed`。對外 status 只合併顯示 `pending` 或 `completed`。重試不得回到已完成階段產生新的外部動作。此流程不刪除 Access 使用者、應用 tenant、membership 或不相符連線。

# Citations

[1] [Cloudflare Live View](https://developers.cloudflare.com/browser-run/features/live-view/)
[2] [Cloudflare Human in the Loop](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/)
[3] [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
[4] [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
