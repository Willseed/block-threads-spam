---
type: Identity Architecture
title: 應用身分與多租戶隔離架構
description: 定義 Cloudflare Access 身分、Threads OAuth 身分、Meta lifecycle 系統身分、租戶所有權與跨租戶拒絕原則。
tags: [identity, tenancy, authorization, meta-lifecycle, session-isolation]
timestamp: "2026-07-19T12:00:00+08:00"
---
# 身分實體

| 實體 | 代表意義 | 主要識別來源 |
|---|---|---|
| 應用使用者 | 登入本服務的人 | Cloudflare Access JWT 的不可變 `sub` |
| 租戶 | 使用者在本服務中的資料與權限邊界 | 預設一位使用者一個個人租戶；未來可擴充團隊租戶 |
| Threads 連線 | 某位使用者授權本服務使用的一個 Threads OAuth token | Meta 官方 `/me` 身分與使用者二次確認 |
| 受保護身分 | 使用者確認要監控的正式 Threads 名稱 | 從 Threads 連線讀取後由使用者確認，不只依賴手動輸入 |
| 候選帳號 | 需要檢查或審核的明確 Threads 使用者名稱 | 有限變形規則或使用者人工加入 |
| Meta lifecycle 系統要求 | 平台發出的解除授權或資料刪除要求 | 通過 HMAC、演算法與 `issued_at` 驗證的 `signed_request` |

# 授權規則

所有敏感要求都必須同時滿足：

1. 應用工作階段有效。
2. 呼叫者屬於目標租戶。
3. 目標 Threads 連線屬於該租戶且未被撤銷。
4. 呼叫者具備對應能力，例如連線、掃描、讀取證據或封鎖。
5. 破壞性動作已完成近期再驗證。
6. 操作的候選帳號與批准內容完全一致。

前端提供的租戶 ID、Threads 連線 ID 或證據鍵都只能作為查詢提示；權威租戶範圍由伺服器依應用使用者身分重新推導。

# Threads 帳號所有權確認

完成 Threads OAuth 後，系統以官方身分端點讀取使用者名稱與平台識別。介面顯示完整名稱與個人檔案摘要，要求使用者確認「這是我要保護的帳號」。只有確認後，系統才建立受保護身分與候選規則。

若工作階段後來切換到另一個 Threads 帳號，系統應偵測身分不一致並停止工作，要求使用者重新連線，而不是默默把既有候選和證據轉移到新帳號。

# Meta lifecycle 系統授權

Meta lifecycle callback 不具有 Cloudflare Access 使用者身分，也不能建立一般租戶 context。Worker 只有在完整驗證 `signed_request` 後，才可把其中的平台使用者識別交給專用 repository 查詢。此查詢是跨 tenant 的狹義例外，規則如下：

1. 只能查詢 `connection_mode = meta_oauth` 且平台使用者識別完全相符的連線。
2. 只能執行撤銷、刪除與最小 receipt／系統稽核，不提供任意讀取或更新能力。
3. 每個命中的連線各自通過 Durable Object owner digest 與 revocation version 檢查。
4. callback 回應不得揭露命中數、tenant、Access subject、username、證據或其他連線。
5. 重送相同要求只繼續或回報既有 receipt，不建立新的擴大清理範圍。
6. Receipt 以 `COORDINATOR_NAMESPACE_KEY` 推導的 subject digest 關聯 OAuth grant；raw Meta ID 完成後清除。OAuth identity stage 必須用同一 digest 與 `oauth_attempts.created_at` Unix seconds 所固定的 authorization boundary 做 D1 原子 `NOT EXISTS` gate，不能取 callback handler 時間，也不能用先查後寫取代。Marker 等於或晚於 boundary 時拒絕舊 attempt；只有 marker 後新建立的 attempt 可通過。

Meta 平台使用者識別不是 Cloudflare Access subject。解除授權或 Meta 資料刪除不得刪除 `users`、`tenants`、`memberships`，也不得刪除同一租戶中不相符的其他 Threads 連線。使用者若要刪除本服務帳號，仍需要獨立、已驗證的應用帳號刪除流程；目前此能力尚未完成。

# 多帳號支援

一位應用使用者可以連線多個 Threads 帳號，但每個連線都具有獨立的：

* token 密文、被包裝資料金鑰與版本。
* Durable Object。
* 候選集合與掃描排程。
* 證據命名空間。
* 封鎖批准與活動紀錄。

介面始終顯示目前操作的正式帳號，封鎖確認頁再次顯示「由哪個帳號封鎖哪個候選」，避免帳號切換造成誤操作。

# 再驗證

下列操作要求短時間內重新確認應用身分：

* 開始新的 Threads 連線。
* 替換現有 Threads OAuth 授權。
* 對候選執行封鎖。
* 下載或查看高敏感證據。
* 中斷連線並刪除工作階段。
* 變更通知、排程或高風險安全設定。

Meta lifecycle callback 不使用上述互動式再驗證；它改以有效 `signed_request`、`issued_at` future-skew 檢查、不可變刪除 cutoff、冪等 receipt 及極小系統權限作為授權鏈。歷史 callback 可重送，但不能影響 cutoff 後重新授權建立的資料。兩種授權鏈不可互相替代。

# 支援與管理權限

客服或平台管理者不得使用使用者的 OAuth token 或人工交接 session，也不得代替使用者執行封鎖。支援角色只能查看去識別化的工作狀態與錯誤分類。任何需要查看原始證據的例外流程都必須有使用者同意、明確案件範圍與管理稽核。

# 相關概念

* [瀏覽器工作階段](../architecture/browser-session-architecture.md)
* [安全架構](../security/security-architecture.md)
* [隱私與同意](../security/privacy-and-consent.md)
