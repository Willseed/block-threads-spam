---
type: System Architecture
title: Threads 變形帳號防護自助式系統總覽
description: 讓使用者登入服務後以官方 OAuth 連線自己的 Threads 帳號，偵測相似變形帳號，並管理授權撤銷與資料刪除生命週期。
tags: [threads, self-service, impersonation, cloudflare, architecture]
timestamp: "2026-07-19T12:00:00+08:00"
---
# 目標

本系統是一個自助式 Threads 身分防護服務。每位使用者先經 Cloudflare Access 登入本服務，再透過 Meta 官方 Threads OAuth 授權自己的 Threads 帳號。系統從已確認的正式帳號名稱建立有限的變形候選，檢查候選是否存在，保存個人檔案證據，並把結果交給帳號本人判斷。Browser Run Live View 僅保留為預設關閉的人工封鎖交接能力，不再承擔主要登入與權杖取得。

封鎖不是由排程自行決定。使用者必須在候選詳情頁確認完整目標帳號；只有人工交接能力已經部署驗證並開啟時，系統才提供該使用者自己的受限瀏覽器工作階段，以完成一次、單一目標的封鎖流程。

# 兩層登入模型

| 層級 | 目的 | 使用者輸入的位置 | 系統保存的內容 |
|---|---|---|---|
| 應用程式登入 | 確認誰正在使用本服務、建立租戶與權限 | Cloudflare Access | Access JWT 所驗證的不可變 subject 與必要應用資料 |
| Threads 授權 | 取得該使用者自己的 Threads API 權限 | Meta 官方 OAuth 頁面 | 每連線加密的長效 access token 與經使用者確認的 Threads 身分 |

兩層身分與授權互不替代。登入本服務不代表已授權 Threads；Threads OAuth token 失效也不應使使用者失去本服務的案件與稽核資料。

# 核心流程

1. 使用者登入本服務並建立個人租戶。
2. 使用者選擇「連線 Threads」，系統建立一次性、綁定 Access session 的 OAuth state，並導向 Meta 官方授權頁。
3. Meta 將使用者導回固定 OAuth callback；系統先原子消耗 state，再交換並加密保存 token。後續 D1 identity stage 使用 OAuth attempt 建立時間的 Unix seconds 作為 authorization boundary，不以 callback 到達或 handler 開始時間代替。
4. 系統透過官方身分回應讀取 Threads 使用者名稱，要求使用者確認這是要保護的正式帳號。
5. 系統以有限規則建立帳號變形候選並執行低頻掃描。
6. 使用者在管理介面檢視候選、相似理由與證據。
7. 使用者對單一帳號給予明確封鎖批准。
8. 系統重新確認目標、保存封鎖前證據、執行一次封鎖並保存結果與稽核紀錄。
9. 使用者可隨時撤銷 Threads 連線並刪除保存的工作階段。

# Meta lifecycle callback

Meta 對解除授權與資料刪除的伺服器要求不具 Cloudflare Access 使用者工作階段，因此只對 `/meta/threads/deauthorize`、`/meta/threads/data-deletion` 與對應的不透明狀態查詢路徑設定精確 Access bypass。Worker 必須先以 `META_APP_SECRET` 驗證 `signed_request` 的 HMAC、演算法及 `issued_at` 格式，並拒絕超出允許 future skew 的時間，才能使用其中的 Meta 平台使用者識別啟動狹義系統清理。

解除授權與資料刪除都建立內部冪等 receipt，將 `issued_at` 固定為不可變刪除 cutoff，並依「Durable Object 撤銷 → R2 物件刪除 → D1 關聯資料清理」執行；只有 data-deletion 對外回傳 confirmation code 與狀態 URL。未完成階段由 Cron 有界重試。OAuth attempt 若建立於 lifecycle marker 之前，即使 authorization code 在 marker 完成後才延遲送達，也會被 subject-digest tombstone gate 拒絕；marker 後新建立的 attempt 才能代表新的授權。歷史要求重送不得刪除 cutoff 後重新授權產生的資料。這個流程只刪除與該 Meta 身分相符的 Threads 連線資料，不刪除 Cloudflare Access 使用者、一般應用租戶或其他連線。

# 架構原則

| 原則 | 架構意義 |
|---|---|
| 帳號本人完成官方授權 | 平台密碼與雙重驗證只在 Meta 官方頁面處理，不經過本服務表單。 |
| 租戶完全隔離 | 每個使用者與每個 Threads 連線都有獨立的工作協調、加密狀態、證據命名空間與授權判斷。 |
| 偵測不是定罪 | 帳號名稱相似只代表需要審核，不代表對方必然冒用或詐騙。 |
| 自動掃描、人工處置 | 排程可以發現與存證，但不能自行批准封鎖。 |
| 單一目標批准 | 每次批准只對應一個完整 Threads 帳號名稱，不允許泛用或無上限批次批准。 |
| 失敗時停止 | 遇到登入失效、CAPTCHA、安全挑戰、頁面不確定或證據服務失敗時停止破壞性動作。 |
| 可撤銷與可追溯 | 使用者能中斷連線；每個掃描、判斷與封鎖結果都有稽核紀錄。 |

# 系統範圍

納入範圍：使用者自助登入、Threads OAuth 授權、正式帳號確認、有限變形候選、候選存在性檢查、相似度排序、證據保存、人工審核、單一帳號封鎖、授權撤銷、Meta 資料刪除 receipt 與活動紀錄。

不納入範圍：保存 Threads 密碼、代替使用者完成雙重驗證、繞過 CAPTCHA 或平台安全機制、全站大量列舉、把相似度直接當作詐騙定論、未經使用者批准的大量封鎖、自動提交冒用檢舉表單，以及由 Meta lifecycle callback 刪除 Cloudflare Access 帳號或整個應用租戶。獨立的「刪除本服務帳號」功能仍待實作。

# 主要關聯

* [身分與多租戶](architecture/identity-and-tenancy.md)
* [瀏覽器工作階段](architecture/browser-session-architecture.md)
* [候選偵測](architecture/candidate-detection.md)
* [畫面架構](experience/screen-architecture.md)
* [安全架構](security/security-architecture.md)

# Citations

[1] [Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/)
[2] [Cloudflare Live View](https://developers.cloudflare.com/browser-run/features/live-view/)
[3] [Cloudflare Human in the Loop](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/)
[4] [Threads API documentation](https://developers.facebook.com/documentation/threads)
