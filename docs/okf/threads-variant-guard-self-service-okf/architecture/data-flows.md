---
type: Data Flow
title: 自助式 Threads 防護端到端資料流
description: 描述應用登入、Threads OAuth、候選掃描、單一封鎖、Meta lifecycle callback、資料刪除與部署機密的資料流。
tags: [data-flow, oauth, scan, block, deauthorization, deletion]
timestamp: "2026-07-19T12:00:00+08:00"
---
# 流程一：使用者註冊與登入

1. 使用者透過應用身分服務完成登入。
2. Worker 建立或載入個人租戶，發出短期應用工作階段。
3. D1 記錄登入事件的最小安全中繼資料，不保存外部身分服務的敏感權杖內容。
4. 使用者進入儀表板；尚未連線 Threads 時只顯示連線引導。

# 流程二：自行連線 Threads

1. 使用者完成近期再驗證並同意 token 保存與自動掃描範圍。
2. Worker 將要求路由至該使用者預定的 Threads 連線 Durable Object，取得單一 connect lease。
3. Worker 建立一次性 state，將雜湊綁定 tenant、使用者、連線、Access session、固定 callback 與期限，並把 `oauth_attempts.created_at` 的 Unix seconds 固定為 authorization boundary。
4. 使用者在 Meta 官方 OAuth 頁面登入並授權；本服務不接觸密碼或雙重驗證碼。
5. callback 原子消耗 state 後交換長效 token，並以官方 `/me` 比對平台使用者識別；D1 stage 以 attempt-created boundary 做 subject-digest tombstone 原子 gate，不取 callback handler 時間。
6. Web 介面要求使用者確認正式帳號。
7. token 以每連線金鑰加密保存於 Durable Object；D1 只建立連線、受保護身分與非機密狀態。
8. 系統產生第一批有限候選，等待首次手動掃描或依同意設定排程。

# 流程三：候選掃描

1. 使用者手動啟動或 Cron 觸發已同意的低頻掃描。
2. Workflows 建立不可變的候選快照，包含人工目標與有限變形結果。
3. Durable Object 取得該帳號執行鎖並驗證 OAuth token 健康。
4. 官方 profile adapter 逐一檢查明確候選，不執行開放式全站搜尋或網頁爬取。
5. 對存在的候選縮減官方回應為 allowlist 個人檔案快照，計算可解釋的相似訊號。
6. R2 保存證據；D1 更新候選、分數、檢查時間與狀態。
7. 掃描結束後釋放執行鎖，對高優先候選發出通知。
8. 排程流程不建立封鎖批准，也不點擊封鎖。

# 流程四：人工審核

1. 使用者開啟候選清單，依風險優先順序查看候選。
2. Worker 僅回傳目前租戶、目前 Threads 連線可存取的資料。
3. 使用者查看帳號名稱差異、顯示名稱、頭像、簡介、連結、證據與最近檢查時間。
4. 使用者選擇「忽略」、「持續監看」或「準備封鎖」。
5. 決策寫入 D1；忽略不等同永久排除，使用者可隨時恢復監看。

# 流程五：單一目標封鎖

1. 使用者從候選詳情選擇「封鎖此帳號」。
2. 介面再次顯示正式帳號、完整目標帳號、最新證據與封鎖影響。
3. 使用者完成近期再驗證並給予只對該完整目標有效的批准。
4. Durable Object 取得封鎖鎖；控制平面建立不可重複使用的動作實例，並確認人工 handoff provider 已部署驗證及開啟。
5. Browser Run 建立只限該使用者與該批准的短期 handoff session，先確認登入身分，再重新開啟目標頁面。
6. 系統驗證頁面上的目標名稱與批准完全一致，保存封鎖前證據。
7. 系統執行一次封鎖並讀取結果；保存封鎖後證據與稽核。
8. 若結果明確，候選標記為已封鎖；若不明，標記為待人工複查且禁止自動重試。
9. 工作完成後關閉瀏覽器並釋放鎖。

# 流程六：人工接管

只有人工 handoff provider 已部署驗證並開啟時，遇到平台挑戰或需要使用者判斷的封鎖介面，系統才為該使用者建立短期 Live View。使用者完成必要操作後，系統重新驗證身分與目標，再決定完成或終止。人工接管不允許擴張原本批准的目標範圍；provider 不可用時流程失敗關閉。

# 流程七：中斷連線與刪除

1. 使用者在設定頁選擇中斷某個 Threads 帳號。
2. 系統要求近期再驗證並顯示將停止的排程與可刪除資料。
3. Durable Object 停止新工作、關閉活動瀏覽器並刪除 token 密文與被包裝資料金鑰。
4. D1 將連線標記為已撤銷；Cron 不再建立工作。
5. R2 證據依使用者的保留或刪除選擇處理。

# 流程八：Meta 解除授權

1. Meta POST 到精確 bypass 的 `/meta/threads/deauthorize`，只提交大小受限的 `signed_request`。
2. Worker 驗證 `algorithm = HMAC-SHA256`、HMAC、`issued_at` 格式／future skew 與必要 payload；驗證前不查詢 D1。
3. 專用 system repository 只查出平台使用者識別完全相符的 `meta_oauth` 連線；查詢可跨 tenant，但不能回傳租戶內容。
4. 系統建立沒有對外 confirmation code 的內部 receipt；每個相符連線停止排程，依 Durable Object revoke、R2 delete、D1 delete 完整清理。
5. 未完成工作由 Cron 有界重試；完成 receipt 移除平台使用者識別，只保留有期限的最小狀態。
6. 重送相同要求取得同一 receipt，且只清理 `issued_at` cutoff 前資料，不產生新連線範圍或刪除後續重新授權資料。Receipt 完成後清除 raw Meta ID，但在期限內保留以 namespace key 推導的 subject digest tombstone；OAuth callback 的 D1 stage 以單一條件更新，將 `oauth_attempts.created_at` Unix seconds 與 marker `issued_at` 比較。Marker 等於或晚於 attempt-created boundary 時拒絕 stage 並清除 DO credential，所以 attempt 在 marker 前建立、authorization code 卻在 marker 完成後才延遲送達也不能寫回舊授權；marker 後新建立 attempt 的 boundary 較新，才允許 stage。

# 流程九：Meta 資料刪除與狀態查詢

1. Meta POST 到 `/meta/threads/data-deletion`；Worker 使用與解除授權相同的簽章、格式及 future-skew 驗證。
2. D1 原子建立或取得既有的不透明 receipt，固定其平台身分雜湊、`issued_at` 刪除 cutoff、階段與範圍，立即回傳 Meta 所需的狀態 URL 與 confirmation code。
3. 清理器逐一處理相符 OAuth 連線：先 Durable Object revoke，再依索引刪除 R2 物件，最後刪除 D1 關聯資料。
4. 任一未完成階段保留 D1 tombstone checkpoint 與安全錯誤分類；Cron 依退避與批次上限重試，不重新產生 receipt。
5. `GET /meta/threads/data-deletion/status/<opaque-receipt>` 只顯示 `pending` 或 `completed`，不揭露內部 processing／retry 分類、user ID、tenant、username、命中數或證據。
6. 清理完成後保留有期限、不可反推平台身分的 keyed subject digest 與最小 receipt／tombstone，以回覆狀態、用 attempt-created boundary 阻擋競態或延遲 callback 中的舊 OAuth stage 並證明完成；歷史要求重送不得刪除 cutoff 後以新 attempt 真正重新授權建立的資料。
7. 此流程不刪除 Cloudflare Access `users`、應用 `tenants`／`memberships` 或其他不相符連線；獨立的本服務帳號刪除仍是缺口。

# 流程十：GitHub Actions 部署與 runtime secrets

1. 不含 `production` environment 或部署 secrets 的 `verify` job 先執行已在本機通過的 lint、typecheck、test 與 build 品質閘門；只有成功才允許後續部署。
2. `deploy` job 明確限制 `refs/heads/main`，並綁定已設定只允許 exact `main` deployment branch 的 `production` environment；經 environment 核准後才取得限定單一 Cloudflare 帳戶的 API Token 與帳戶識別。
3. job 將應用 runtime secret 值寫入 runner 暫存目錄中的 `0600` secrets file，不輸出內容、不保存 artifact；Cloudflare API Token 本身不寫入該檔或 Worker runtime。
4. 已存在的 `threads-variant-guard` Worker record 是 staged upload 前置條件。workflow 使用 `wrangler versions upload` 上傳帶有 `github-${sha}-${run_id}-${run_attempt}` 唯一 tag 與 runtime secrets 的未啟用 Worker version；同一 commit 的新 run 由 run ID 區分，同一 run 的 rerun 由 run attempt 區分，不會指向模糊 tag。上傳本身不切換正式流量，並可在既有 Worker 自動 provision `threads-variant-guard-db` 與 `threads-variant-guard-evidence`。
5. 未啟用 version 上傳成功後，workflow 才套用遠端 D1 migrations；migration 成功後再依同一 run 的唯一 tag 解析並啟用該 version。migration 失敗時現行 production version 維持啟用，不讓依賴新 schema 的 version 接收流量。
6. 無論成功、失敗或取消，`always()` cleanup 都移除 runner 暫存 secrets file。正式發布驗證另應在啟用後執行不含敏感資料的健康檢查，並保留 GitHub／Cloudflare 部署稽核。

# 相關概念

* [使用者旅程](../experience/user-journey.md)
* [封鎖批准流程](../experience/block-approval-flow.md)
* [故障模型](../operations/failure-model.md)
