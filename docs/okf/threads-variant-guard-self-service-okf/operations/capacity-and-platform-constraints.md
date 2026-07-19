---
type: Platform Constraints
title: 容量與外部平台限制
description: 記錄 Cloudflare Browser Run、Live View 與 Threads 外部介面對多使用者架構的限制。
tags: [limits, browser-run, live-view, threads, capacity]
timestamp: "2026-07-20T12:00:00+08:00"
---
# Browser Run 限制

Browser Run 的用量、同時瀏覽器數、新 Session 建立速率與閒置逾時依 Cloudflare Workers 方案而異。它只服務預設關閉的人工封鎖交接；架構不能假設每位使用者都能立即取得長時間常駐瀏覽器。OAuth 連線與官方 profile 查詢不依賴 Browser Run 配額。

Cloudflare 文件指出 Browser Run 預設在閒置後關閉，能以 keep-alive 延長閒置時間；Live View 產生的前端連結也具有短期有效性。因此連線頁必須顯示倒數、重新取得能力與取消流程。

# 多租戶容量策略

* 使用者撤銷與單一人工封鎖交接優先於其他 Browser Run 工作。
* 官方 API 背景掃描按租戶公平性、Meta rate limit 與固定配額分批執行。
* 同一 Threads 連線永遠只使用一個活動 Browser Run 工作。
* 候選數量與頁面逾時均有上限。
* 所有瀏覽器工作在成功、失敗或取消後明確關閉。
* 超額時延後排程，不把工作擴張成高併發。

# Live View 與 Human in the Loop

Live View 與 Human in the Loop 是可選人工封鎖交接能力，且屬快速演進功能。架構將 Live View 視為短期能力，不把其 URL 當作長期應用路由或 OAuth 恢復方式。若該能力不可用，人工封鎖交接暫停；OAuth 連線與官方 profile 查詢仍可運作，也不得降級成要求使用者上傳 Cookie 或 Session 檔。

# Session Recording

Browser Run 可選擇記錄瀏覽器 Session，但人工交接不啟用錄製。官方 profile 查詢不建立瀏覽器 Session；人工封鎖只保存最小證據與結構化稽核，不保存完整重播資料。

# Threads API 與網頁介面

Threads 官方 API 文件列出的主要能力包含發文、讀取媒體與個人檔案、管理回覆及 Insights，未列出一般使用者封鎖端點。因此本架構把封鎖視為需要使用者 Threads 網頁工作階段的外部介面操作，而不是可靠的官方 API 呼叫。

由於 Threads 頁面、按鈕名稱、登入風控與限制可能變動，所有頁面操作都需要：

* 登入身分再確認。
* 目標帳號再確認。
* 可觀測的停止條件。
* 介面變更時的快速停用開關。
* 不繞過平台安全控制。

# 平台條款與營運風險

瀏覽器自動化可能被外部網站辨識或限制。服務上線前需完成平台條款、隱私政策、資料處理與使用者同意的法律審查。產品文案不可暗示 Meta 官方背書，也不可保證候選一定會被找到或封鎖一定成功。

# Meta lifecycle 與刪除容量

公開 lifecycle callback 可能被偽造流量或有效歷史要求重送。驗證前工作必須保持常數級且有 body 限制；只有 HMAC、`issued_at` 格式及 future-skew 合格後，才能依雜湊後的平台身分套用 D1 速率限制並建立 receipt。歷史時間固定為 deletion cutoff，所有批次只處理 cutoff 前資料。資料刪除按 receipt、連線及 R2 tombstone checkpoint 分批，使用固定每次上限與退避，優先於背景掃描但不阻塞登入、使用者撤銷或其他 receipt。

receipt status 路徑不執行清理，只讀取最小狀態；高熵 code、快取禁止與查詢速率限制防止列舉。完成 receipt 有明確保留期限，過期後不得以狀態頁反推出曾存在的 Meta 身分。

# 部署平台限制

GitHub Actions 與 Cloudflare API 都有權限、執行時間及速率限制。部署 workflow 必須使用最小權限帳戶 token、受保護 environment 和可重跑的非機密步驟；runtime secret 傳遞、migration 與 deploy 的部分成功需可辨識。禁止因 CI 故障改用 Global API Key 或把機密寫入 repo。

# 替代路徑

若遠端 Live View 的 Beta 狀態、風控或帳號安全風險不符合正式營運要求，人工封鎖能力維持 fail closed，使用者直接在 Threads 官方介面完成操作。任何未來替代路徑仍不得要求使用者以聊天、Email 或檔案分享方式交付 Cookie、token 或 Session。

# Citations

[1] [Cloudflare Browser Run limits](https://developers.cloudflare.com/browser-run/limits/)
[2] [Cloudflare Live View](https://developers.cloudflare.com/browser-run/features/live-view/)
[3] [Cloudflare Human in the Loop](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/)
[4] [Cloudflare Session Recording](https://developers.cloudflare.com/browser-run/features/session-recording/)
[5] [Threads API documentation](https://developers.facebook.com/documentation/threads)
