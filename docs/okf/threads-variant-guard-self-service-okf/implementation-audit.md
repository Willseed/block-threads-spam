---
type: Implementation Audit
title: 依 OKF 架構之實作完成度審核報告
description: 追蹤 block-threads-spam 與本知識包之 OAuth、CI 部署、Meta lifecycle、刪除及既有安全控制的符合度。
tags: [audit, completeness, threads-variant-guard, deployment, meta-lifecycle]
timestamp: "2026-07-20T12:00:00+08:00"
---

# 審核狀態

本文件已依 2026-07-20 的目標架構更新。CI 與 Meta lifecycle 的程式、migration、GitHub Actions workflow 及本機品質閘門已完成，Cloudflare Worker bootstrap 也已在 dashboard 建立；custom domain 掛載、Cloudflare Access path policy、實際部署與 Meta App 設定仍待環境驗證。本節只記錄已實際執行的本機結果，不把 bootstrap 等同正式部署或 Meta callback 驗證。

2026-07-19 的控制平面實作是本次工作的基線：Cloudflare Access 身分驗證、租戶隔離、官方 Threads OAuth、每連線 token vault、有限候選、私有證據、一次性批准、排程不封鎖及 fail-closed handoff 已有對應程式與測試。新增 lifecycle 與 CI 後，所有既有品質結論都必須重新驗證。

# 本次範圍狀態

| 項目 | 狀態 | 驗證條件 |
|---|---|---|
| OKF 納入 repo、manifest 與索引 | 文件完成 | `manifest.json` 包含 `implementation-audit.md`；所有內部連結在 repo 子目錄可解析 |
| GitHub Actions 部署 | workflow 完成／待遠端驗證 | 無 secrets 的 verify job、只允許 `refs/heads/main` 的 deploy job、單一部署 concurrency、未啟用 version upload、D1 migration、依 `github-${sha}-${run_id}-${run_attempt}` 唯一 tag activation；`production` environment 已在 GitHub 設為 exact `main`，尚待實際 run |
| runtime secrets 傳遞 | GitHub 設定完成／待部署驗證 | 九個 Actions secrets 已存在；deploy job 使用 runner 暫存 `0600` secrets file，並以 `always()` cleanup 移除；尚待 run log 確認遮罩、Workers Secrets 傳遞與部署 token 不進 runtime |
| Cloudflare API Token 最小權限 | 外部設定完成 | 使用單一 account-scoped token；權限限 Workers Scripts Edit、D1 Edit、Workers R2 Storage Edit、Account Settings Read，未給 DNS／Access／route／KV／Tail |
| Cloudflare Worker bootstrap | 外部設定完成／正式發布待驗證 | 帳戶原無 `threads-variant-guard`；dashboard 已一次性建立無 binding 的 Hello World Worker record，使 `versions upload` 可運作。既有 Worker 可 automatic provision `threads-variant-guard-db`／`threads-variant-guard-evidence`；staged upload 本身不能建立全新 Worker |
| Custom domain → Worker mapping | 外部設定待完成 | dashboard 目前對 `threads-variant-guard` 顯示 custom domain `—`；`spam.buy2330.cc` 尚未掛到此 Worker，正式部署後須驗證 mapping、TLS、Access path policy 與 callback reachability |
| `/meta/threads/*` Access 邊界 | 外部設定待驗證 | 只對 deauthorize、data-deletion、opaque status path bypass；其餘 hostname 與路徑仍要求 Access |
| Meta `signed_request` 驗證 | 本機已驗證／待 Meta 實流量 | `HMAC-SHA256`、WebCrypto verify、body 限制、單一欄位、canonical base64url、app ID 與 `issued_at` future-skew 皆有正負測試；未虛構 max-age |
| Meta deauthorization | 本機已驗證／待 Meta 實流量 | 內部 receipt 執行 DO→R2→D1 相符連線清理、不回傳公開 confirmation code、同 payload 重送冪等且與 data deletion 分域 |
| data-deletion receipt／status | 本機已驗證／待 Meta 實流量 | 回傳 64 字元 hex confirmation code 與 status URL；固定 `issued_at` cutoff；狀態只回 pending／completed；重送取得既有 receipt |
| 狹義跨 tenant 清理 | 本機已驗證 | 只查相符 platform user ID 的 `meta_oauth` 連線；跨 tenant 舊 grant 清除、cutoff 後新 grant 保留、Access user／tenant／membership 保留；OAuth stage 以 `oauth_attempts.created_at` Unix seconds 作 boundary，具 subject-digest tombstone 原子 gate |
| DO → R2 → D1 刪除與 Cron retry | 本機已驗證／待遠端資源 | 固定向前階段、R2 有界批次與 D1 tombstone checkpoint、D1 最後清理、lease token、防 stale worker、錯誤分類退避與 Cron bounded retry 均有測試 |
| Meta App dashboard lifecycle URL | 待部署後設定 | HTTPS callback 可由 Meta 抵達並通過簽章；OAuth callback 仍維持 Access session state 綁定 |
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

* 未啟用 Worker version upload、遠端 D1 migration、依每次 workflow run 唯一 tag activation，以及各階段失敗時保持既有 production version 的復原路徑；同 SHA rerun 必須由 run ID／run attempt 明確區分。
* GitHub Actions runtime secret 遮罩、Workers Secrets 傳遞、`always()` 暫存檔清理及部署後健康檢查；`production` environment 的 exact `main` 限制已完成外部設定。
* 將 `spam.buy2330.cc` 掛到 `threads-variant-guard` Worker；目前 dashboard custom domain 為 `—`。掛載後再實際確認三個精確 public path 可達，其餘 API、OAuth callback 與 SPA 仍受 Access 保護。
* Meta App dashboard 儲存 callback URL，並由 Meta 發送真實 signed request／data deletion callback 驗證。

# 已知缺口

* 刪除本服務帳號及其 Access 對應資料仍未實作；Meta data deletion 只處理 Meta 來源資料。
* Browser Run provider 仍預設 fail closed，人工封鎖交接必須在真實環境驗證後才能開啟。
* 通知、候選詳情與篩選、活動匯出、完整安全告警等既有產品缺口不因本次 lifecycle 工作而自動完成。
* Meta App 仍需在部署後填入可工作的 deauthorization 與 data-deletion URL，並完成開發／審查模式所需驗證。
* `issued_at` max-age 尚未實作；目前安全語意是 future-skew 驗證加 immutable deletion cutoff。如要加入 max-age，需先確認 Meta 重送行為並補相容性測試。

# 結論

OKF、程式、migration、workflow、本機品質閘門與一次性 Worker bootstrap 已完成；剩餘閘門是正式 GitHub Actions／Cloudflare 部署、`spam.buy2330.cc` 掛載、Access path policy 與 Meta App callback 的外部驗證。完成這些項目後，才能把遠端狀態改為「已驗證」。
