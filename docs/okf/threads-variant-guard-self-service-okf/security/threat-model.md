---
type: Threat Model
title: 自助式 Threads 防護威脅模型
description: 分析應用帳號接管、OAuth token 與部署機密外洩、Meta lifecycle 偽造、跨租戶清理、Live View、誤封與平台風控。
tags: [threat-model, oauth-token, ci-secret, meta-lifecycle, cross-tenant, abuse]
timestamp: "2026-07-20T12:00:00+08:00"
---
# 受保護資產

* 應用使用者帳號與租戶權限。
* Threads OAuth token 與每連線資料金鑰。
* Live View 短期控制能力。
* 候選及封鎖證據。
* 封鎖批准、工作狀態與稽核紀錄。
* 服務主密鑰與平台機密。
* Cloudflare 部署 API Token、GitHub Actions runtime secrets 與部署供應鏈。
* Meta `signed_request` 驗證邊界、資料刪除 receipt 與清理 checkpoint。

# 主要威脅與控制

| 威脅 | 可能影響 | 主要控制 |
|---|---|---|
| 應用帳號被接管 | 攻擊者可查看證據或批准封鎖 | MFA／Passkey、異常登入偵測、敏感動作再驗證、工作階段撤銷 |
| Live View URL 洩漏 | 攻擊者在人工封鎖交接期間控制遠端瀏覽器 | 一次性短效交付、不寫日誌、不透過通知傳送、離開即終止、綁定應用工作階段與單一批准 |
| Threads token 密文外洩 | 攻擊者嘗試重放使用者授權 | 每連線認證加密、資料金鑰分離、不可下載、快速撤銷、身分一致性檢查 |
| 跨租戶資料存取 | 使用者讀取他人證據或操作他人 Threads | 伺服器端租戶推導、每帳號 Durable Object、私有 R2、每次資料存取重新授權 |
| 候選產生被濫用 | 系統變成帳號列舉或騷擾工具 | 有限規則、候選上限、正式帳號綁定、速率限制、禁止通用搜尋 |
| 相似度誤判 | 正常帳號被誤封 | 可解釋分數、人工審核、單一目標批准、最新證據與目標再確認 |
| 目標切換或頁面劫持 | 系統封鎖錯誤帳號 | 平台識別與使用者名稱雙重比對、封鎖前截圖、不一致即停止 |
| 重複封鎖提交 | 結果不明或錯誤重試 | Durable Object 鎖、一次性批准、Workflow 階段、結果不明禁止自動重試 |
| 平台挑戰或 CAPTCHA | 帳號被限制或流程失控 | 立即停止、使用者 Live View 接管、不得繞過、低頻掃描 |
| 內部人員濫用 | Session 或證據被未授權查看 | 客服無 Session 權限、敏感管理雙人審核、完整管理稽核、最小權限 |
| 證據連結被分享 | 第三方個資外洩 | R2 私有、短效授權回傳、無匿名 URL、存取稽核與保留期限 |
| 供應鏈或日誌外洩 | 機密進入第三方服務 | 敏感欄位遮罩、禁止記錄 Session／Live View、縮減第三方前端腳本、秘密輪替 |
| GitHub Actions 或 Cloudflare token 被濫用 | 攻擊者部署惡意 Worker、讀取部署機密或操作其他資源 | 單一帳戶最小權限 token、environment 核准、workflow `contents: read`、不向 fork 提供 secrets、固定 action 版本、輪替與部署稽核 |
| 偽造 Meta lifecycle callback | 攻擊者撤銷或刪除他人資料 | 精確 Access bypass、先驗證 `HMAC-SHA256`、常數時間比較、`issued_at` future-skew、驗證前零資料查詢 |
| 重放有效歷史 `signed_request` | 重複清理、資源耗盡，或刪除後續重新授權資料 | 不可變 receipt cutoff／scope、payload 雜湊、只清理 cutoff 前資料、冪等階段、速率限制、重送只查既有狀態 |
| OAuth exchange、延遲 callback 與 lifecycle marker 交錯 | callback 尚未 stage 平台 ID，marker 已完成後舊 authorization code 才送達並試圖寫回 token／連線 | 以 `oauth_attempts.created_at` Unix seconds 固定 authorization boundary、keyed subject digest tombstone、D1 原子 stage gate；`marker.issued_at >= boundary` 即拒絕並清除 DO credential，marker 後新 attempt 才允許；stage 先完成時由 cutoff processor 清理 |
| 狹義跨租戶清理權限擴張 | callback 刪除不相干 tenant 或連線 | 只查相符 platform user ID 的 `meta_oauth` 連線、無一般 repository API、逐連線 owner 驗證、禁止刪除 user／tenant／membership |
| receipt code 被猜測或分享 | 第三方得知刪除進度或內部資訊 | 高熵不透明 code、最小狀態回應、no-store、速率限制、期限與雜湊保存 |
| DO／R2／D1 部分刪除 | token 或證據殘留，或先刪索引失去清理能力 | 固定 DO→R2→D1 順序、持久 receipt／D1 tombstone checkpoint、Cron 有界重試、D1 最後刪除、完成前維持 pending |

# 濫用情境

本服務只應由帳號本人或其合法管理者使用。禁止以他人的 Threads OAuth 授權連線、替他人進行未授權封鎖、建立大規模帳號名單、測試憑證或規避平台限制。偵測到租戶大量建立連線、短期切換多個帳號或異常高量候選時，系統暫停並要求人工安全審查。

# 安全事件處置

若懷疑 Threads token 外洩：立即停用連線、終止所有 Browser Run Session、銷毀密文與資料金鑰、撤銷 Meta App 授權或要求重新授權，並保存不含 token 的事件稽核。

若懷疑跨租戶漏洞：立即關閉相關讀寫路徑、撤銷短期證據能力、保全安全日誌、通知受影響使用者，並在修復前停止所有破壞性操作。

若懷疑部署 token 或 workflow 供應鏈外洩：立即撤銷 Cloudflare API Token、停用部署 environment、比對 GitHub 與 Cloudflare 部署稽核、輪替所有可能暴露的 runtime secrets，並重新部署已知可信版本。

若 Meta lifecycle callback 出現異常簽章拒絕或大規模 receipt：保持 callback fail closed、暫停清理 dispatcher、保存不含 raw payload 的雜湊稽核，確認 Access bypass 與 App Secret 後再恢復未完成 receipt。

# 相關概念

* [安全架構](../security/security-architecture.md)
* [故障模型](../operations/failure-model.md)
* [部署拓樸](../architecture/deployment-topology.md)
