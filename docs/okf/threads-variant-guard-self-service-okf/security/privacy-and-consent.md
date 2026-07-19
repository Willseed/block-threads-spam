---
type: Privacy Architecture
title: 隱私、同意與資料生命週期
description: 定義使用者在連線 Threads、排程掃描、保存證據與刪除資料時的告知及控制。
tags: [privacy, consent, retention, deletion]
timestamp: "2026-07-20T12:00:00+08:00"
---
# 同意層級

使用者需要分別同意：

1. 建立本服務帳號與必要安全日誌。
2. 透過 Meta 官方 OAuth 授權 Threads 權限。
3. 加密保存 Threads 長效 token 供後續官方 API 查詢。
4. 依指定頻率檢查有限候選。
5. 保存候選與封鎖證據。
6. 對每一個目標執行封鎖。

前四項不能以一次模糊同意全部涵蓋；封鎖批准永遠逐次取得。

# 資料清單

| 資料 | 目的 | 建議保留 |
|---|---|---|
| 應用使用者與租戶識別 | 登入、授權與稽核 | 帳號存在期間及必要法定期間 |
| Threads 帳號識別與正式名稱 | 綁定受保護身分 | 連線存在期間 |
| 加密 Threads OAuth token | 執行使用者授權的官方 API 查詢 | 到期、撤銷或長期未使用即刪除 |
| 候選名稱與相似理由 | 審核與監看 | 依使用者設定及案件狀態 |
| 候選與封鎖證據 | 支援判斷與操作追溯 | 掃描證據短期；正式處置證據較長但可設定 |
| 稽核事件 | 安全、除錯與責任鏈 | 以最小化欄位保留既定期間 |
| Live View URL | 可選人工封鎖交接 | 不持久保存；使用後或逾時立即失效 |
| Meta 資料刪除 receipt | 回覆刪除進度、冪等重試與完成證明 | 完成後只保留不可反推身分的最小狀態，依明確期限刪除 |

# 最小化原則

* 不保存 Threads 密碼或雙重驗證碼；只由 Meta 官方頁面處理。
* 不要求使用者上傳瀏覽器 Profile、Cookie 檔或 Session 檔。
* 不保存登入過程的 Session Recording。
* 候選證據以個人檔案必要區域為主。
* 不為了相似度而長期保存完整第三方個人檔案副本。
* 日誌使用內部識別與錯誤分類，不寫入敏感頁面內容。

# 使用者控制

設定頁提供：

* 查看已連線 Threads 帳號與最後使用時間。
* 暫停或恢復排程。
* 變更候選規則與通知。
* 刪除單一候選證據。
* 中斷 Threads 連線並刪除工作階段。
* 刪除本服務帳號及其資料（目標能力；目前尚未實作）。
* 匯出不包含 Session 的活動與決策紀錄。

# 中斷連線

中斷連線後，系統立即停止新工作並刪除 token 密文及被包裝資料金鑰。使用者可選擇同時刪除全部候選與證據，或在明確保留期間內保存案件紀錄。無論選擇為何，都不能保留可再次呼叫 Threads API 的授權資料。

# Meta 解除授權與資料刪除

有效 deauthorization callback 代表 Meta 已撤回 App 授權。系統建立內部 receipt，停止相符 OAuth 連線的排程，並依 Durable Object、R2、D1 順序完整清理 cutoff 前的相符連線資料；此類 receipt 不提供公開 confirmation code。

有效 data-deletion callback 建立具不透明 confirmation code 的 receipt，並刪除所有與該 Meta 平台使用者識別相符、且在 `issued_at` cutoff 前完成授權的 Threads 連線資料。清理可以跨越多個 tenant 中的誤重複連線，但只能處理完全相符的 `meta_oauth` 連線，且依 Durable Object、R2、D1 順序執行。完成 receipt 不保留 raw Meta ID，只在期限內保存不可反推的 keyed subject digest；OAuth stage 以 attempt 建立時間而非 callback 時間作為 boundary，因此 marker 前開始、marker 完成後才延遲回來的 callback 仍被拒絕，只有 marker 後由使用者新建立的 attempt 可留下新授權。狀態頁只顯示 `pending` 或 `completed`，不顯示平台識別、username、tenant 或證據。

Meta user ID 與 Cloudflare Access subject 是不同身分。上述 callback 不授權刪除本服務 `users`、`tenants`、`memberships`、其他 Threads 連線或 Access 帳號。使用者完整刪除本服務帳號仍需另外提供已驗證的自助流程；目前這是明確的隱私控制缺口。

# 第三方資料

候選個人檔案屬於其他 Threads 使用者。系統只在保護帳號本人與處理疑似冒用所需範圍內收集公開或該使用者合法可見的資料，並提供保留期限與刪除機制。不得把候選資料另作廣告、人物剖析或通用搜尋資料庫。

# 透明度

介面需明確告知：本服務以官方 OAuth／Profiles API 連線，但人工封鎖可能使用預設關閉的瀏覽器交接而非 Threads 官方封鎖 API；平台可能要求重新授權或限制操作；使用者可隨時撤銷；Meta 資料刪除不等同刪除本服務帳號；相似度不是詐騙判決。

# 相關概念

* [瀏覽器工作階段](../architecture/browser-session-architecture.md)
* [安全架構](../security/security-architecture.md)
* [平台能力與限制](../references/platform-capabilities.md)
