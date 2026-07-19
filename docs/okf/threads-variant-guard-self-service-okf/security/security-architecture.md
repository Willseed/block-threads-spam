---
type: Security Architecture
title: 自助式 Threads 防護安全架構
description: 以分離部署身分、雙層使用者身分、OAuth token 加密、Meta lifecycle 簽章、私有證據與單一目標批准保護使用者。
tags: [security, zero-trust, encryption, tenant-isolation, ci, meta-lifecycle]
timestamp: "2026-07-20T12:00:00+08:00"
---
# 安全目標

1. 未登入者不能建立 Browser Run Session、查看候選或執行封鎖。
2. 已登入使用者不能讀取或操作其他租戶的 Threads 連線、證據或工作。
3. Threads 密碼與雙重驗證資訊不經本服務後端。
4. 保存的 Threads OAuth token 即使密文被取得，也有應用層加密、每連線金鑰與 AAD 範圍限制。
5. Live View 不得被記錄、轉寄或長期重用。
6. 每次封鎖都能追溯到使用者、正式帳號、目標、證據版本與結果。
7. 不確定時停止，不自動擴張、重試或繞過平台安全機制。
8. GitHub Actions 部署憑證不能進入 Worker runtime，runtime secrets 不能進入 log、artifact 或 fork PR。
9. 公開 Meta lifecycle 路徑只能在有效 `signed_request` 且 `issued_at` 未超出允許 future skew 時啟動狹義撤銷或刪除；歷史要求以不可變 cutoff 限制影響範圍。
10. Meta 資料刪除不能擴張成刪除 Cloudflare Access 使用者、整個應用 tenant 或其他連線。

# 驗證與工作階段

應用身分由 Cloudflare Access JWT 驗證，Threads 身分由官方 OAuth 與 `/me` 建立。OAuth state 綁定 Access session 並只能消耗一次；長效 token 與 Access JWT 使用不同生命週期及撤銷機制。Live View 僅在人工交接 feature 經驗證後提供，且只能由已完成近期再驗證的連線擁有者建立。

# 部署與機密邊界

* GitHub Actions 使用限定單一 Cloudflare 帳戶、只含部署必要操作的 API Token，不使用 Global API Key。
* workflow permissions 預設為 `contents: read`；無 secrets 的 verify job 必須先成功。部署 job 明確限制 `refs/heads/main`，並綁定已在 GitHub 外部設定只允許 exact `main` deployment branch 的 `production` environment；fork pull request 不取得 secrets。
* runtime secret 值只寫入 runner 暫存目錄中權限 `0600` 的 secrets file，供未啟用 version upload 使用；禁止放在命令列參數、debug trace、cache 或 artifact，並由 `always()` cleanup 移除。
* Cloudflare API Token 與帳戶識別只存在部署平面，不列入 Worker bindings，也不進入 `.dev.vars`。
* 第三方 action 固定可信版本；部署與 token 使用保留 GitHub／Cloudflare 管理稽核，並具備輪替與撤銷程序。

# 租戶隔離

* 所有 D1 查詢由伺服器端使用者身分加上租戶條件。
* Durable Object 識別由伺服器依使用者與 Threads 連線衍生。
* R2 物件鍵包含不可預測的租戶與案件識別，不以帳號名稱作為唯一授權。
* 證據下載由 Worker 代理並在每次存取前重新授權。
* 工作佇列或 Workflow 事件只保存內部不可猜測識別，不相信呼叫者傳入的租戶範圍。
* Meta lifecycle 的跨 tenant 查詢是唯一狹義系統例外：必須先通過簽章，再只查平台識別相符的 OAuth 連線，且 repository 不提供一般租戶資料讀取能力。

# Threads OAuth token 保護

* 每個 Threads 連線使用獨立資料金鑰。
* token 以認證加密保存，密文包含版本、AAD 與完整性資訊。
* 解密只發生於該連線 Durable Object 協調的短暫工作期間。
* 明文 token 不寫入 D1、R2、Worker RPC、分析、錯誤追蹤或一般日誌。
* 客服與平台管理者沒有匯出或解密介面。
* 使用者撤銷連線時銷毀可用密文或對應金鑰。

# Meta lifecycle 安全

* Access bypass 僅涵蓋兩個 POST callback 與一個不透明 receipt status 路徑；其他 host/path 維持 Access 保護。
* callback 限定 method、content type、body 大小與速率；只解析單一 `signed_request` 欄位。
* 解碼 payload 後要求 `algorithm` 精確為 `HMAC-SHA256`，使用 `META_APP_SECRET` 對原始 payload segment 計算 HMAC 並常數時間比較。
* `issued_at` 必須存在且格式有效；超出允許 future skew、格式錯誤或簽章不符一律在資料查詢前拒絕。歷史 `issued_at` 不因 max-age 自動拒絕，而是保存為不可變刪除 cutoff。
* raw `signed_request`、簽章、Meta user ID 與 receipt code 不進一般 log；稽核只保存雜湊與安全分類。
* data-deletion receipt 的 cutoff 與範圍建立後不可擴張；重送只取得相同狀態或延續未完成階段，且不得刪除 cutoff 後重新授權產生的資料。
* receipt 在期限內保留 keyed subject digest tombstone；authorization boundary 固定為 OAuth attempt 建立時的 `oauth_attempts.created_at` Unix seconds，而非 callback 到達或 handler 開始時間。D1 identity stage 以單一 `UPDATE ... NOT EXISTS` 對照 tombstone：marker `issued_at >= attempt boundary` 時 stage 失敗並清除 DO credential，包括 marker 已完成後才送達的延遲 callback；marker 後新建立的 attempt 才能通過。Stage 先完成時 lifecycle processor 仍會依 cutoff 命中並撤銷。
* cleanup 嚴格依 DO revoke、R2 delete、D1 delete，並在每階段具備冪等 checkpoint；D1 不能先刪除定位資訊。

# Live View 安全

* 連結短期、一次性、只交付給發起者。
* 不在 Email 或推播中傳送。
* 不讓第三方分析工具讀取包含 Live View 的頁面。
* 使用嚴格內容安全政策與來源限制。
* 登入期間關閉 Session Recording。
* 使用者離開、取消或逾時後，立即終止遠端瀏覽器。

# 證據安全

R2 保持私有。截圖以最小必要區域為主，避免收集動態消息、私訊與無關人物。證據物件具有租戶、Threads 連線、候選與工作關聯；D1 保存物件索引、雜湊、建立時間與保留狀態。

# 破壞性動作控制

* 封鎖需要近期再驗證。
* 每次只批准一個完整帳號。
* 執行前重新確認登入者與目標。
* 封鎖前證據與稽核不可用時停止。
* 結果不明不自動重試。
* 排程與候選分數永遠不能直接產生批准。

# 濫用防護

註冊、登入、Live View 建立、手動掃描與封鎖批准皆有使用者、IP、租戶與 Threads 連線層級的速率限制。異常大量候選、頻繁連線替換或跨地域高風險登入會觸發額外驗證或暫停。

# 安全監控

監控訊號包括部署 token 使用、runtime secret 傳遞失敗、Meta callback 簽章／future-skew 拒絕、歷史 callback 與 cutoff 保護、receipt 重送與積壓、跨租戶狹義清理數量、DO／R2／D1 刪除階段失敗、一般跨租戶拒絕、Live View 兌換失敗、token 解密失敗、登入帳號不一致、候選數量異常、封鎖重複提交與證據存取異常。安全日誌不得包含 API Token、runtime secret、OAuth token、raw `signed_request`、receipt code、Cookie、密碼或完整 Live View URL。

# Citations

[1] [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
[2] [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
[3] [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/)
[4] [Cloudflare Live View](https://developers.cloudflare.com/browser-run/features/live-view/)
