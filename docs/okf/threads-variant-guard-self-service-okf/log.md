# Directory Update Log

## 2026-07-20
* **Bundle integration**: 將知識包納入專案，補列 `implementation-audit.md`，並修正子目錄中的文件連結。
* **Deployment**: 加入 GitHub Actions 以最小權限 Cloudflare API Token 部署、傳遞 Workers runtime secrets，以及部署機密與執行期機密分離的架構。實測確認同名 Hello World Worker 不足以建立首次 `v1 new_sqlite_classes`；先嘗試的 `versions upload` 以 code `10211` 失敗後，重用 partial D1／R2、在 bootstrap 準備階段套用 D1 migrations `0001`–`0007`，再用無 secrets／assets／cron且預設 `503` 的 fail-closed normal deploy 套用同一 DO migration。GitHub Actions run `29696901680` attempt 4 隨後確認 `No migrations to apply`、完成完整版本 promotion，並取代 bootstrap；新環境不必刻意重現該次失敗。
* **Access configuration**: 首次允許使用者登入證明 Access 邊界可通過，但 Worker 內部 JWT 驗證因不透明的 issuer／audience 部署值而對 API 回 `401`。`TEAM_DOMAIN` 與主 Application `POLICY_AUD` 屬公開識別資訊，改為版本化 Worker vars；GitHub Actions 與 `secrets.required` 只保留五項剩餘 Worker secret bindings。OKF 同步加入第二層 JWT 設定錯誤的故障模式與 promotion 後登入驗證閘門。
* **Meta lifecycle**: 定義 `/meta/threads/*` 精確公開邊界、`signed_request` HMAC、`issued_at` future-skew 與不可變刪除 cutoff、解除授權、資料刪除和狀態查詢流程。
* **Deletion**: 定義跨租戶但僅限同一 Meta 平台身分的系統清理，依 Durable Object 撤銷、R2 刪除、D1 清理的順序執行，並以 receipt 與 Cron 做冪等重試。
* **Scope clarification**: Meta 資料刪除不刪除 Cloudflare Access 使用者或一般租戶；本服務帳號刪除功能仍是已知缺口。
* **Verification**: CI 與 Meta lifecycle 本機品質閘門、正式 GitHub Actions／Cloudflare 部署、`spam.buy2330.cc` custom domain、Access 精確 route matrix 及 Meta App 三個 callback URL 已完成。GitHub Pages custom-domain 設定仍是待移除的控制平面殘留，但已不是 DNS origin。仍待允許使用者的完整 Access／OAuth 往返及 Meta 真實 signed callback／remote cleanup 驗證。

## 2026-07-19
* **Redesign**: 將原本單一管理者架構改為多使用者自助式架構。
* **Identity**: 新增應用程式登入與 Threads 登入的雙層身分模型。
* **Session**: 改為由每位使用者透過遠端可見瀏覽器自行輸入 Threads 憑證與完成雙重驗證。
* **Tenancy**: 新增每位使用者及每個已連線 Threads 帳號的資料、工作與工作階段隔離。
* **Experience**: 新增可操作網頁的頁面架構、候選審核與單一封鎖批准流程。
* **Scope**: 僅描述架構、流程、安全、頁面與營運模型；不包含原始碼、部署指令或 API 實作範例。
