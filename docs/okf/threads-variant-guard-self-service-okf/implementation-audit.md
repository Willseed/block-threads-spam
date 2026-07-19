---
type: Implementation Audit
title: 依 OKF 架構之實作完成度審核報告
description: 追蹤 block-threads-spam 與本知識包之 OAuth、CI 部署、Meta lifecycle、刪除及既有安全控制的符合度。
tags: [audit, completeness, threads-variant-guard, deployment, meta-lifecycle]
timestamp: "2026-07-20T12:00:00+08:00"
---

# 審核狀態

本文件已依 2026-07-20 的實際部署結果更新。CI 與 Meta lifecycle 的程式、migration、GitHub Actions workflow、本機品質閘門、首次 Durable Object bootstrap、正式 staged deployment、custom domain、Cloudflare Access route boundary 及 Meta App callback URL 均已完成。bootstrap 準備階段已套用 D1 migrations `0001`–`0007`；GitHub Actions run `29696901680` attempt 4 確認 `No migrations to apply` 並啟用完整版本。本節不把匿名 invalid callback 路由驗證等同 Meta 真實 signed request 或完整 lifecycle cleanup 驗證。

2026-07-19 的控制平面實作是本次工作的基線：Cloudflare Access 身分驗證、租戶隔離、官方 Threads OAuth、每連線 token vault、有限候選、私有證據、一次性批准、排程不封鎖及 fail-closed handoff 已有對應程式與測試。新增 lifecycle 與 CI 後，所有既有品質結論都必須重新驗證。

# 本次範圍狀態

| 項目 | 狀態 | 驗證條件 |
|---|---|---|
| OKF 納入 repo、manifest 與索引 | 文件完成 | `manifest.json` 包含 `implementation-audit.md`；所有內部連結在 repo 子目錄可解析 |
| GitHub Actions 部署 | 遠端驗證完成 | bootstrap 準備階段已套用 D1 migrations `0001`–`0007`；run `29696901680` attempt 4 通過無 secrets verify、main-only deploy、未啟用 version upload、確認無待辦 migration 與 run-unique tag activation。正式 tag 為 `github-75a2368a0e36fc7ba1d24a6c94bdecf126333f5b-29696901680-4` |
| runtime secrets 傳遞 | 遠端驗證完成 | 九個 Actions secrets 已存在；deploy job 以 runner 暫存 `0600` secrets file 傳入七個 Workers Secrets，Cloudflare token 不進 runtime，`always()` cleanup 成功且 log 未顯示 secret 值 |
| Cloudflare API Token 最小權限 | 外部設定完成 | 使用單一 account-scoped token；權限限 Workers Scripts Edit、D1 Edit、Workers R2 Storage Edit、Account Settings Read，未給 DNS／Access／route／KV／Tail |
| Cloudflare Worker／DO bootstrap | 外部驗證完成 | 同名 Hello World 只滿足 Worker record；本次先嘗試 `versions upload` 時因首次 `v1 new_sqlite_classes` 尚未建立而收到 code `10211`。已查核並重用 partial D1／R2、套用 `0001`–`0007`，再以無 secrets／assets／cron、預設 `503` 的 fail-closed normal deploy 套用同一 `ConnectionCoordinator` migration，隨後由完整版本取代；新環境不必刻意重現失敗 |
| Custom domain → Worker mapping | 外部驗證完成／Pages 殘留待清理 | Cloudflare DNS 舊 GitHub Pages CNAME 已由 Worker Custom Domain 取代，`spam.buy2330.cc` TLS 可用；GitHub Pages 的 custom-domain 設定仍待移除，但目前不是 DNS origin，也不承載 Worker 流量 |
| Meta lifecycle Access 邊界 | 外部路由驗證完成 | 只對 deauthorize、data-deletion、opaque status path bypass；匿名 invalid POST 到兩個 callback 回 Worker `400`、未知 status 回 `404`，`/`、`/api/me`、OAuth callback 與未知 meta path 回 Access `302` |
| Meta `signed_request` 驗證 | 本機已驗證／待 Meta 實流量 | `HMAC-SHA256`、WebCrypto verify、body 限制、單一欄位、canonical base64url、app ID 與 `issued_at` future-skew 皆有正負測試；未虛構 max-age |
| Meta deauthorization | 本機已驗證／待 Meta 實流量 | 內部 receipt 執行 DO→R2→D1 相符連線清理、不回傳公開 confirmation code、同 payload 重送冪等且與 data deletion 分域 |
| data-deletion receipt／status | 本機已驗證／待 Meta 實流量 | 回傳 64 字元 hex confirmation code 與 status URL；固定 `issued_at` cutoff；狀態只回 pending／completed；重送取得既有 receipt |
| 狹義跨 tenant 清理 | 本機已驗證 | 只查相符 platform user ID 的 `meta_oauth` 連線；跨 tenant 舊 grant 清除、cutoff 後新 grant 保留、Access user／tenant／membership 保留；OAuth stage 以 `oauth_attempts.created_at` Unix seconds 作 boundary，具 subject-digest tombstone 原子 gate |
| DO → R2 → D1 刪除與 Cron retry | 本機已驗證／待真實 Meta 流量 | 遠端 DO、R2、D1 與 cron 已部署；固定向前階段、R2 有界批次與 D1 tombstone checkpoint、D1 最後清理、lease token、防 stale worker、錯誤分類退避與 Cron bounded retry 均有測試，尚未以真實 callback 執行 cleanup |
| Meta App dashboard callback URL | 外部設定完成／待真實 Meta 流量 | Threads use case 已保存 OAuth redirect、uninstall 與 delete callback；App Basic／Advanced lifecycle URL 也已保存。OAuth callback 仍受 Access；尚待 Meta 真實 signed request 與登入往返 |
| 刪除本服務帳號 | 未實作 | 需另建已驗證的 Access 使用者自助刪除流程；不能由 Meta callback 代替 |

# 必須保持的架構不變量

1. GitHub 部署身分、Cloudflare Access 使用者身分與 Meta 平台身分是三個不可互換的信任域。
2. Cloudflare API Token 只存在 CI 部署平面；`META_APP_SECRET` 等應用機密只以 Workers Secrets 提供給 runtime。
3. lifecycle callback 驗證前不查 D1、不呼叫 Durable Object、不讀寫 R2，也不建立 tenant context。
4. 跨 tenant 是 provider lifecycle 清理的狹義系統能力，只能命中平台識別完全相符的 OAuth 連線。
5. deauthorization 與 data deletion 都依 DO revoke、R2 delete、D1 delete 完成相符連線清理；只有 data deletion 對外提供 confirmation/status。
6. receipt 的 `issued_at` cutoff 與 scope 一經建立不可擴張；重試只從未完成 checkpoint 繼續，並排除 cutoff 後重新授權資料。
7. Meta data deletion 不刪除 Cloudflare Access user、應用 `users`、`tenants`、`memberships` 或其他連線。
8. 候選分數與排程仍不能建立封鎖批准；任何不確定的外部封鎖結果仍不得自動重試。

# 品質閘門紀錄

2026-07-20 已在 Workers Vitest 本機環境執行：

* `npm run check`：lint、typecheck、25 個 test files／138 個 tests、Worker 與 client production build 全部通過。Build 僅提示本機未提供七個 production secrets；CI 將由 Actions secret store 注入。
* `actionlint .github/workflows/deploy.yml`：通過。
* `git diff --check`：通過。
* OKF `manifest.json`：JSON 有效，與 28 個 Markdown 文件完全一致；本機 Markdown 連結可解析。
* 測試覆蓋 signed request 正負案例、oversized body、future skew、歷史 cutoff、callback 重送、跨 tenant、Access principal 保留、DO／R2／D1 順序、R2 寫入／撤銷競態、lease stale owner、Cron retry、opaque status，以及 OAuth exchange 中插入 lifecycle marker 的原子 stage gate。
* OAuth boundary 回歸測試明確覆蓋兩個方向：attempt 在 lifecycle marker 前建立、marker 完成後 callback 才延遲送達時，stage 仍依 attempt `created_at` boundary 拒絕並清除 DO credential；marker 完成後新建立的 attempt 則可正常 stage，且 `oauth_granted_at` 保存該 attempt boundary。

仍需在外部環境執行並記錄：

* 由允許的 Access 使用者完成一次應用登入及 Threads OAuth 往返，確認 `/api/me`、state 綁定與 token exchange 的 production 行為。
* 由 Meta 發送真實 signed deauthorization／data-deletion callback，確認 remote Durable Object → R2 → D1 清理、receipt status 與 Cron retry；目前只完成本機正負測試與 production 匿名 route matrix。
* 演練日常 staged deployment 的 migration／activation 失敗復原，以及已驗證 version 的流量回復；首次 DO bootstrap 已完成，不應在一般發布中重做。

# 已知缺口

* 刪除本服務帳號及其 Access 對應資料仍未實作；Meta data deletion 只處理 Meta 來源資料。
* Browser Run provider 仍預設 fail closed，人工封鎖交接必須在真實環境驗證後才能開啟。
* 通知、候選詳情與篩選、活動匯出、完整安全告警等既有產品缺口不因本次 lifecycle 工作而自動完成。
* Meta App callback URL 已填妥，但 App 仍處於開發／未發布狀態；正式提供給非角色使用者前仍需完成 Meta 要求的測試、權限與審查流程。
* `issued_at` max-age 尚未實作；目前安全語意是 future-skew 驗證加 immutable deletion cutoff。如要加入 max-age，需先確認 Meta 重送行為並補相容性測試。

# 結論

OKF、程式、migration、workflow、本機品質閘門、一次性 fail-closed DO bootstrap、正式 GitHub Actions／Cloudflare 部署、`spam.buy2330.cc` mapping、Access 精確 path policy 與 Meta App callback URL 均已完成。剩餘遠端閘門是允許使用者的完整 Access／OAuth 往返、Meta 真實 signed callback 與 remote lifecycle cleanup；不得以匿名 invalid callback 路由驗證取代這些結論。
