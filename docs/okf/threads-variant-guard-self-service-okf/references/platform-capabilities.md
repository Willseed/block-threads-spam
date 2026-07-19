---
type: Reference
title: OKF、Cloudflare 與 Threads 平台能力參考
description: 彙整本知識包所依據的 OKF、Cloudflare CI／Access／Secrets、Threads OAuth 與 Meta lifecycle 官方能力，並標示服務端額外控制。
tags: [reference, okf, cloudflare, github-actions, threads, meta-lifecycle]
timestamp: "2026-07-20T12:00:00+08:00"
---
# Open Knowledge Format

OKF v0.1 將知識包定義為 Markdown 目錄樹；概念文件使用 YAML frontmatter，並以 `type` 為必要欄位。`index.md` 用於目錄，`log.md` 用於更新紀錄。本知識包依此結構組織，僅描述架構知識，不包含實作原始碼。

# Cloudflare Browser Run

Browser Run 提供可程式控制的遠端 Chrome，並可透過 Playwright、Puppeteer 或 CDP 操作。Live View 允許人類即時查看與操作遠端瀏覽器；Human in the Loop 文件明確將人工登入、多因素驗證與敏感資料輸入列為使用情境。

本架構不再用 Browser Run 作為主要 Threads 登入方式；使用者改在 Meta 官方 OAuth 頁面登入。Live View 只保留為預設關閉、需另行整合驗證的人工封鎖交接能力，仍不得用來要求使用者上傳 Cookie 或 Session 檔。

# Live View 時效與 Session

Live View 前端能力是短期連結；Browser Run Session 也具有預設閒置逾時與方案限制。架構因此需要一次性交付、倒數、重新取得、明確關閉、排隊與配額控制。

# Durable Objects 與 Workflows

Durable Objects 提供具有持久儲存的強一致單一協調實體，適合以每個 Threads 連線序列化工作。Workflows 可保存多步工作狀態與恢復非破壞性步驟；封鎖步驟仍由本架構額外限制，不因平台重試能力而自動重做。

# GitHub Actions、API Token 與 Workers Secrets

Cloudflare 的 GitHub Actions 指南要求非互動式 CI 提供 `CLOUDFLARE_API_TOKEN` 與 account ID，並建議把 token 限縮到實際部署帳戶。Cloudflare 的 account-owned token 相容性表目前列出 Workers、D1、R2 與 Durable Objects；權限參考則分別提供 Workers Scripts、D1、Workers R2 Storage 等 account-scoped Read／Edit 權限。實際 token 必須依 workflow 真正呼叫的 API 選擇最小集合，不能直接把寬廣模板視為最低需求。

Workers Secrets 是加密的 runtime bindings。Cloudflare 文件支援宣告 `secrets.required`，以及在 deploy／version upload 時以 secrets file 或 bulk request 傳入。本服務在受保護 deploy job 中使用 runner 暫存目錄下權限 `0600` 的 secrets file 建立未啟用 version，並以 `always()` cleanup 移除；檔案權限、遮罩、不輸出內容與清理仍是本服務的責任。Cloudflare 部署 API Token 本身不是應用 runtime secret，不得加入 secrets file 或 Worker bindings。

本次 Cloudflare 帳戶實測顯示，`versions upload` 可對既有 Worker 進行 staged upload 與 automatic provisioning，但不能建立全新的 Worker service record。因此已先在 dashboard 一次性建立無 binding 的 Hello World `threads-variant-guard`；後續 upload 可建立／綁定 `threads-variant-guard-db` 與 `threads-variant-guard-evidence`。這個 bootstrap 與 custom domain mapping 是不同外部狀態；dashboard 對該 Worker 顯示 custom domain `—` 時，不能宣稱 `spam.buy2330.cc` 已指向它。

# Cloudflare Access 精確公開路徑

Cloudflare Access application path 可為共同 hostname 下的更精確路徑建立獨立規則；更具體的 path 優先。官方常見政策文件指出 Bypass 適用於必須公開的 OAuth callback 或 webhook，但會停用 Access 控制與 Access request logging，因此必須盡量縮小範圍。

本服務只為三個 `/meta/threads/*` lifecycle 用途建立精確 path application／Bypass。HMAC、`issued_at` future-skew、不可變 deletion cutoff、body 限制、速率限制與最小回應是 bypass 後必須由 Worker自行承擔的應用層控制；不得把 Bypass 擴大到整個 hostname。

# Threads API

Threads 官方 API 提供 OAuth 授權與個人檔案等能力，實作用它建立每連線 token 並查詢明確候選。官方能力列表仍未列出一般使用者封鎖 API。因此本架構推論：要以某位使用者的帳號封鎖另一個 Threads 個人檔案，仍需由使用者直接操作官方介面，或使用預設關閉且經驗證的人工瀏覽器交接。

此推論應持續以最新 Meta 官方文件驗證；若未來提供正式封鎖 API，架構應優先改用可限制權限、可撤銷的官方 OAuth 流程。

# Meta lifecycle 與資料刪除

Meta App 的資料刪除 callback 使用 `signed_request`，並要求應用開始刪除後回傳狀態 URL 與 confirmation code。`signed_request` 的 HMAC 驗證授權平台使用者識別；本服務拒絕超出允許 future skew 的 `issued_at`，但目前不對歷史時間套用 max-age 拒絕。歷史 `issued_at` 會成為不可變 deletion cutoff，使舊要求重送不會刪除其後重新授權產生的資料。receipt 去重與分階段 DO→R2→D1 清理是本服務的安全強化，不應誤寫成 Meta 對所有 App 的固定秒數或儲存模型；若未來加入 max-age，必須另行記錄並驗證相容性。

Meta lifecycle payload 的平台 user ID 只用來定位該 App 下相符的 Threads OAuth 連線，不能證明 Cloudflare Access 使用者或 tenant 所有權。Meta data deletion 因此不刪除 Access user、應用 tenant、membership 或其他 provider 資料；完整應用帳號刪除仍需獨立功能。

OAuth attempt 建立時間作為 authorization boundary、subject-digest tombstone 與 D1 原子 stage gate 都是本服務針對 lifecycle／OAuth 交錯的安全控制，不是 Meta callback payload 自帶的授權世代。Boundary 必須取持久化的 `oauth_attempts.created_at` Unix seconds；若改取延遲 callback 的到達或 handler 時間，marker 前建立的舊 attempt 可能被錯認成 marker 後新授權。

# Threads 封鎖與檢舉的差異

Meta Help Center 分別提供 Threads 封鎖個人檔案與檢舉內容／個人檔案的說明。封鎖限制使用者與目標之間的互動，不等同向 Meta 提交冒用案件。本架構目前只涵蓋候選發現與封鎖協助，不自動提交冒用檢舉。

# 官方參考

[1] [Open Knowledge Format v0.1 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
[2] [Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/)
[3] [Cloudflare Live View](https://developers.cloudflare.com/browser-run/features/live-view/)
[4] [Cloudflare Human in the Loop](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/)
[5] [Cloudflare Browser Run limits](https://developers.cloudflare.com/browser-run/limits/)
[6] [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
[7] [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)
[8] [Threads API documentation](https://developers.facebook.com/documentation/threads)
[9] [Block or unblock a profile on Threads](https://help.instagram.com/616605623708734/)
[10] [Report something on Threads](https://help.instagram.com/6602413966453273/)
[11] [Cloudflare Workers GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
[12] [Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
[13] [Cloudflare account-owned API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)
[14] [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
[15] [Cloudflare Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
[16] [Cloudflare Access common policies: bypass a public endpoint](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/)
[17] [Meta App data deletion callback](https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback/)
