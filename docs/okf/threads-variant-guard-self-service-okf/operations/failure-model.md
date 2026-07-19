---
type: Failure Model
title: 自助式 Threads 防護故障模型
description: 定義登入、OAuth、Meta lifecycle、資料刪除、CI 部署、資料服務與封鎖結果異常時的保守處置。
tags: [failure, fail-closed, recovery, deletion, deployment]
timestamp: "2026-07-20T12:00:00+08:00"
---
# 故障處置表

| 情境 | 立即處置 | 使用者看到的狀態 | 復原方式 |
|---|---|---|---|
| 應用工作階段失效 | 拒絕操作，不建立 Browser Run | 需要重新登入本服務 | 使用者重新登入，未批准動作不自動恢復 |
| Live View 人工交接連結逾時 | 終止短期 handoff session，不重用舊連結 | 人工操作已停止 | 經再驗證及新批准取得新的短期 Live View；不得把舊封鎖批准當成重試 |
| 使用者取消或未完成 Threads OAuth | 消耗或到期 state，不保存不完整 token | 連線未完成 | 使用者重新開始 OAuth |
| Threads OAuth token 失效 | 停止該帳號所有官方查詢與封鎖交接 | 需要重新授權 Threads | 使用者重新完成 Meta 官方 OAuth |
| 登入帳號與綁定帳號不一致 | 將 Session 標記為不可用並停止 | 帳號不一致 | 使用者確認並重新登入正確帳號 |
| CAPTCHA、challenge 或 checkpoint | 暫停工作，不嘗試繞過 | 需要本人處理 | 提供短期 Live View 或要求使用者在官方介面完成驗證 |
| 候選帳號不存在 | 記錄不存在，不採取動作 | 目前找不到 | 依退避策略低頻重新檢查 |
| Threads 頁面結構變更 | 保存最小診斷並停止相關動作 | 服務暫時無法辨識頁面 | 更新頁面辨識規則並重新驗證 |
| 目標頁面與批准名稱不一致 | 立即停止並使批准失效 | 目標不一致 | 重新掃描、重新審核、建立新批准 |
| Durable Object 不可用 | 停止該帳號全部工作 | 工作暫停 | 服務恢復後重新建立非破壞性工作 |
| 工作階段解密或完整性失敗 | 停止並標記安全事件 | 需要重新連線 | 銷毀失效版本、輪替金鑰、重新登入 |
| R2 寫入失敗 | 封鎖前停止；掃描標記證據不完整 | 無法保存證據 | 儲存恢復後重新掃描，不補做封鎖 |
| D1 寫入失敗 | 破壞性動作前停止 | 稽核服務不可用 | 恢復後建立新工作與新批准 |
| Workflows 重試至破壞性步驟 | 阻止自動重做外部封鎖 | 待人工複查 | 檢查工作階段與 Threads 現況後由使用者決定 |
| 封鎖結果不明 | 不重試，保存最後已知階段 | 需要人工複查 | 使用者檢查 Threads 封鎖狀態後補記結果 |
| Browser Run 配額耗盡 | 拒絕新的人工封鎖交接；OAuth 與官方 API 查詢不受此配額影響 | 人工操作容量不足 | 等待配額恢復或調整服務方案與調度 |
| 使用者撤銷連線時仍有工作 | 先阻止新步驟並終止活動 Browser Run | 正在安全中斷 | 工作結束後銷毀工作階段與完成撤銷 |
| Meta callback 未通過 HMAC／演算法驗證 | 在任何資料查詢前拒絕 | 不提供使用者資料或命中資訊 | 修正 Meta App Secret／callback 設定後由 Meta 重送；不得人工略過驗證 |
| `issued_at` 缺少、格式錯誤或過度超前 | 視為無效，不建立 receipt | 一般錯誤回應 | 校正 Meta 設定／系統時鐘後等待有效要求；不得略過 future-skew |
| 歷史 `issued_at` callback 重送 | 使用既有 receipt／cutoff，只處理 cutoff 前資料 | 相同 confirmation/status | 不以 max-age 當成已實作拒絕；確認 cutoff 後重新授權資料完全不受影響 |
| lifecycle callback 重送 | 取得既有 receipt 或繼續原階段 | 相同 confirmation/status | 依 receipt 冪等處理，不擴張 scope |
| OAuth attempt 在 lifecycle marker 前建立，但 callback 在 marker 完成後才延遲送達 | 以 attempt `created_at` boundary 命中 subject-digest tombstone，拒絕 D1 stage 並清除剛寫入 DO 的 credential | OAuth 連線失敗，不恢復舊授權 | 使用者若仍要授權，必須在 marker 後重新開始 OAuth，建立具有較新 boundary 的新 attempt |
| DO revoke 失敗 | 不進入 R2／D1 清理，receipt 維持 pending | 刪除處理中 | Cron 依退避重試 DO；超限後告警，不可先刪 D1 定位資料 |
| R2 部分刪除 | 保存 D1 `deleted_at` tombstone checkpoint，不進入 D1 最終清理 | 刪除處理中 | Cron 只重新列出未標記項目並有界重試；已刪物件視為成功 |
| D1 最終清理失敗 | token 與 R2 已不可用，保留最小 checkpoint | 刪除處理中 | Cron 冪等重試 D1；完成後只保留最小 receipt／tombstone |
| receipt status code 無效或過期 | 不透露是否存在對應使用者 | 找不到或已過期 | Meta／使用者使用原 confirmation code；營運者不得搜尋回傳個資 |
| GitHub 品質閘門失敗 | verify job 不具 `production` environment 或部署 secrets，deploy job 不啟動 | workflow 失敗 | 修復後重新執行完整閘門 |
| Worker record 不存在 | `versions upload` 失敗，不套用 migration、不切換流量 | 部署前置條件未完成 | 只允許營運者一次性建立名稱精確相符的 Worker record；不要把 record 存在誤判為 DO bootstrap 已完成 |
| 首次 `v1 new_sqlite_classes` 尚未建立 | 若先執行 `versions upload`，可能以 code `10211` 失敗且留下 partial D1／R2 | 部署前置條件未完成 | 不必刻意重現失敗；精確建立或重用 D1／R2、只補缺少的資源，以明確 binding 和停用 automatic provisioning 套用 D1 migrations，再用同 class／migration、無 secrets／assets／cron且預設 `503` 的 fail-closed bootstrap 執行一次正常 `wrangler deploy`，完成後立即以完整版本取代 |
| runtime secrets file 建立或未啟用 version upload 失敗 | 不套用 migration、不切換 production 流量，禁止輸出 secret 值；已建立的遠端資源仍可能保留 | 部署未完成 | `always()` 移除暫存檔；查核既有 Worker、DO migration、D1／R2 partial state 與權限後，由受保護 environment 重跑，不盲目刪除資源 |
| 未啟用 version 上傳成功但 D1 migration 失敗 | 不啟用新 version，現行 production version 維持服務 | 發布未完成 | 修復 migration 後由同一受保護 workflow 重跑；不得手動略過 migration 或直接啟用新 version |
| D1 migration 成功但依 run-unique tag activation 失敗 | 新 schema 已套用，但新 version 不接收流量；保持既有 production version | 發布未完成 | 確認 migration 向後相容，修復 activation 後由同一受保護 workflow 安全重跑，並核對 SHA、run ID 與 run attempt 完整 tag |
| custom domain、TLS 或 Access mapping 錯誤 | 不能把 Worker version 成功視為公開路由與信任邊界皆正常 | 網址不可用、錯誤指向或保護範圍不正確 | 查核 `spam.buy2330.cc` Worker custom domain、TLS、主 hostname Access 與三個精確 lifecycle bypass；匿名 route matrix 必須符合預期 |
| 新 version 啟用後健康檢查失敗 | 停止後續發布，標記需回復 | 部署異常 | 依已驗證 version 回復流量並保存 GitHub／Cloudflare 稽核；已套用 migration 依相容性策略處理 |

# 失敗關閉順序

封鎖必要條件依序為：有效應用身分、近期再驗證、正確租戶、有效 Threads 連線、單一目標批准、帳號執行鎖、登入身分一致、目標一致、封鎖前證據成功、稽核可寫入。任一條件不成立，都不能進入封鎖動作。

# 不確定結果原則

外部平台可能在點擊後、確認前中斷。此時自動重試可能對已變更頁面或不同目標採取動作，因此工作狀態必須停在「待人工複查」。介面提供最後已知頁面、時間與證據，但不提供立即重試捷徑。

# 降級模式

* Browser Run 不可用：仍可登入本服務、完成 OAuth、執行官方 profile 查詢及查看既有候選與證據；不能進行人工封鎖交接。
* R2 不可用：可查看不需影像的既有中繼資料；禁止新封鎖。
* D1 不可用：整個應用維持唯讀或拒絕敏感操作。
* Workflows 不可用：可保留有限手動唯讀操作；不執行長流程。
* 通知不可用：核心工作可完成，但需在儀表板顯示未送達狀態。
* Meta lifecycle dispatcher 不可用：callback 仍可在 D1 建立或取得 receipt，狀態保持 pending；恢復後由 Cron 繼續，不能宣稱已完成。
* GitHub Actions 不可用：既有服務繼續運作；不得改用本機 Global API Key 繞過受保護部署流程。

# 相關概念

* [封鎖批准流程](../experience/block-approval-flow.md)
* [營運模型](../operations/operational-model.md)
* [威脅模型](../security/threat-model.md)
