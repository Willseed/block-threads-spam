---
type: Operational Architecture
title: 自助式 Threads 防護營運模型
description: 定義多租戶掃描、Meta lifecycle receipt、資料刪除重試、CI 部署、通知、可觀測性與資料清理。
tags: [operations, workflows, scheduling, observability, deletion, deployment]
timestamp: "2026-07-20T12:00:00+08:00"
---
# 工作類型

| 工作 | 啟動者 | 是否使用 Browser Run | 是否可封鎖 |
|---|---|---|---|
| Threads OAuth 連線 | 使用者 | 否，由 Meta 官方 OAuth 處理 | 否 |
| 手動掃描 | 使用者 | 否，使用官方 profile API | 否 |
| 定期掃描 | Cron 與調度器 | 否，使用官方 profile API | 否 |
| 候選重新整理 | 使用者 | 否，只查一個明確 username | 否 |
| 單一封鎖 | 使用者批准 | 是 | 是，只限一個帳號 |
| OAuth token 健康檢查 | 系統或使用者 | 否，使用官方 API／token 狀態 | 否 |
| 中斷連線 | 使用者 | 視是否有活動 Session | 否 |
| Meta 解除授權 | Meta lifecycle callback 與 Cron | 僅終止既有活動 Session | 否；完整清理相符連線，不回傳公開 confirmation code |
| Meta 資料刪除 | Meta lifecycle callback 與 Cron | 僅終止既有活動 Session | 否；完整清理相符連線並提供公開 receipt status |
| 生產部署 | 受保護 GitHub Actions environment | 否 | 否；只管理 Cloudflare 部署與 runtime secrets |

# 工作生命週期

1. 已接收：應用身分有效。
2. 已授權：租戶、Threads 連線與能力通過檢查。
3. 已限制範圍：候選快照或單一目標已固定。
4. 等待帳號鎖：避免同一 Threads 連線併發。
5. 驗證工作階段：確認 Threads 身分與健康。
6. 執行中：Browser Run 處理有限頁面。
7. 已存證：必要 R2 證據可讀。
8. 已寫入稽核：D1 工作與結果完整。
9. 已完成、已停止或待複查。

封鎖工作另外需要「已再驗證」與「已批准」階段。

lifecycle receipt 使用 `pending`、`processing`、`completed` 狀態；連線自身的 `revoking` 狀態與仍存在的 R2／D1 索引共同形成 DO、R2、D1 清理 checkpoint。receipt 固定 `issued_at` deletion cutoff，相同 callback 重送只能取得既有 receipt 或喚醒未完成工作，不能重設 scope，也不能處理 cutoff 後重新授權建立的資料。data-deletion status 對外只映射為 `pending` 或 `completed`。

# 部署模型

* 不含 `production` environment 或部署 secrets 的 `verify` job 先執行已通過本機驗證的 lint、typecheck、test 與 build 閘門；deploy job 以 `needs` 依賴完整成功結果。
* deploy job 同時以 workflow 條件限制 `refs/heads/main`，並綁定已設定 exact `main` deployment branch 的 GitHub `production` environment；permissions 採最小化，fork pull request 不取得 secrets。
* Cloudflare API Token 限定單一帳戶與部署所需 Workers／D1／R2 操作，不使用 Global API Key。
* runtime secret 值只在 deploy job 寫入 runner 暫存目錄中的 `0600` secrets file，供 `wrangler versions upload` 建立未啟用 version；部署 token 不成為 runtime secret，暫存檔由 `always()` cleanup 移除。
* 同名 Worker record 只是 staged upload 的第一項前置條件；無 binding 的 Hello World Worker 無法套用首次 `v1 new_sqlite_classes` migration。初始化時應精確建立或重用 D1／R2、只補缺少的資源，再以明確 binding 與 `--no-experimental-provision` 套用或確認 D1 migrations。
* 一次性 fail-closed bootstrap 以正常 `wrangler deploy` 使用同一 `ConnectionCoordinator` class／migration、不帶 runtime secrets／assets／cron並預設回應 `503`；只建立首次 DO migration，完成後立即由完整應用版本取代。code `10211` 是本次先嘗試 `versions upload` 時觀察到的原因，不是必要的部署步驟。
* 後續 workflow 先上傳帶 `github-${sha}-${run_id}-${run_attempt}` 唯一 tag、尚未接收流量的 Worker version，再執行 D1 migration check／apply，最後只啟用同一次執行 tag 所指 version。`run_id` 區分同一 commit 的不同 run，`run_attempt` 區分同一 run 的 rerun，避免 tag 歧義。上傳或 migration 失敗時保留現行 production version；activation 失敗時 migration 可能已完成，但新 version 仍不接收流量，必須由同一受保護 workflow 安全重跑。
* bootstrap 準備階段已套用 D1 migrations `0001`–`0007`；GitHub Actions run `29696901680` attempt 4 完成 upload、確認 `No migrations to apply` 並完成 tag promotion，bootstrap 已被完整版本取代。正式版本 tag 為 `github-75a2368a0e36fc7ba1d24a6c94bdecf126333f5b-29696901680-4`。
* `spam.buy2330.cc` 已掛載 Worker 並通過 TLS／路由驗證。主 hostname 由 Cloudflare Access 保護；只有 deauthorize、data-deletion 與 opaque status 三個用途精確 bypass，匿名 invalid callback 回到 Worker `400`、未知 status 回 `404`，受保護頁面與 API 回 Access `302`。

# 排程策略

* 排程預設低頻，由使用者明確啟用。
* 每個 Threads 連線具備獨立時區與下一次執行時間。
* Cron 只負責喚醒調度；Workflows 依配額分批啟動帳號工作。
* 不在同一租戶或同一 Threads 連線同時執行多個瀏覽器工作。
* 不存在候選採指數退避；新高優先候選可提高下一次人工提示，不提高無上限掃描頻率。
* Cron 另以固定批次上限認領未完成 lifecycle receipt，只從尚未完成的連線／證據狀態繼續；清理工作優先於背景掃描，但不得壟斷所有執行時間。

# 併發與公平性

Durable Object 保證單一 Threads 連線的序列化；全域調度以租戶公平性、Browser Run 併發上限與每日用量為基礎。Meta 資料刪除可命中多個 tenant，但必須逐連線取得撤銷協調並以固定批次執行；它不能繞過 owner digest 或擴張到其他連線。大量使用者或惡意 callback 不應讓單一 receipt 壟斷執行時間。

# 通知

可通知事件：

* 發現新的高優先候選。
* Threads OAuth token 失效，需要重新授權。
* 封鎖成功、停止或待複查。
* 排程因平台挑戰或配額暫停。
* 使用者的 Threads 連線被撤銷。
* Meta 資料刪除完成或進入需營運介入的安全失敗狀態。

通知不包含 OAuth token、Live View URL、handoff session、完整敏感證據或可直接執行封鎖的連結；使用者必須回到已登入的 Web 應用。

# 可觀測性

| 訊號 | 目的 |
|---|---|
| 每工作階段啟動與關閉原因 | 控制 Browser Run 用量與發現未正常關閉的 Session |
| 工作階段健康與重新登入率 | 評估雲端瀏覽器對 Threads 風控的影響 |
| 候選數與規則來源 | 防止候選範圍異常擴張 |
| 掃描成功率與頁面辨識失敗率 | 發現 Threads 介面改版 |
| Live View 建立、兌換與逾時 | 發現人工封鎖交接體驗與能力洩漏風險 |
| 封鎖前置條件失敗與結果不明 | 評估破壞性流程可靠性 |
| 跨租戶拒絕與證據存取 | 偵測安全事件 |
| R2、D1、Durable Object、Workflows 錯誤 | 決定是否失敗關閉 |
| lifecycle HMAC、演算法與 future-skew 拒絕 | 偵測偽造與未來時間操弄；不得保存 raw `signed_request` |
| 歷史 `issued_at`、receipt cutoff 與後續重新授權排除 | 確認舊要求重送不會刪除 cutoff 後的新資料 |
| receipt 年齡、階段、重試與積壓 | 確認 Meta 刪除在期限內完成，發現 DO／R2／D1 卡住 |
| 每 receipt 命中連線數與跨 tenant 數的安全聚合 | 發現平台身分映射異常，不揭露 tenant 或 user ID |
| GitHub deploy、Cloudflare API Token 使用與 runtime secret 傳遞 | 發現未核准部署或機密交付失敗；不得記錄值 |

所有日誌禁止包含 Cookie、OAuth token、handoff session、密碼、雙重驗證碼與完整 Live View URL。

# 資料清理

定期清理過期 Live View 中繼資料、撤銷 token、已超過保留期的掃描證據、完成或失敗的 Workflow 狀態、不再使用的加密金鑰版本，以及已超過 receipt 保留期的不可識別 tombstone。一般清理受租戶範圍控制；Meta lifecycle 清理則受已驗證平台身分與固定 receipt scope 控制。

資料刪除必須保持 DO revoke → R2 delete → D1 delete。R2 以固定上限分批刪除，D1 的 `deleted_at` tombstone 是可重試 checkpoint；D1 最後才移除連線與索引。即使完成資料刪除，Cloudflare Access user、應用 tenant 與 membership 仍保留；獨立應用帳號刪除端點尚未完成。

# Citations

[1] [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)
[2] [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
[3] [Cloudflare Browser Run limits](https://developers.cloudflare.com/browser-run/limits/)
