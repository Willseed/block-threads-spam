# Directory Update Log

## 2026-07-20
* **Bundle integration**: 將知識包納入專案，補列 `implementation-audit.md`，並修正子目錄中的文件連結。
* **Deployment**: 加入 GitHub Actions 以最小權限 Cloudflare API Token 部署、傳遞 Workers runtime secrets，以及部署機密與執行期機密分離的架構。Cloudflare dashboard 已一次性建立無 binding 的 `threads-variant-guard` Hello World Worker 作為 staged upload bootstrap；custom domain 尚未掛到此 Worker。
* **Meta lifecycle**: 定義 `/meta/threads/*` 精確公開邊界、`signed_request` HMAC、`issued_at` future-skew 與不可變刪除 cutoff、解除授權、資料刪除和狀態查詢流程。
* **Deletion**: 定義跨租戶但僅限同一 Meta 平台身分的系統清理，依 Durable Object 撤銷、R2 刪除、D1 清理的順序執行，並以 receipt 與 Cron 做冪等重試。
* **Scope clarification**: Meta 資料刪除不刪除 Cloudflare Access 使用者或一般租戶；本服務帳號刪除功能仍是已知缺口。
* **Verification**: CI 與 Meta lifecycle 本機品質閘門已完成；正式 GitHub Actions／Cloudflare 部署、Access path policy 與 Meta callback 實流量仍待外部驗證。

## 2026-07-19
* **Redesign**: 將原本單一管理者架構改為多使用者自助式架構。
* **Identity**: 新增應用程式登入與 Threads 登入的雙層身分模型。
* **Session**: 改為由每位使用者透過遠端可見瀏覽器自行輸入 Threads 憑證與完成雙重驗證。
* **Tenancy**: 新增每位使用者及每個已連線 Threads 帳號的資料、工作與工作階段隔離。
* **Experience**: 新增可操作網頁的頁面架構、候選審核與單一封鎖批准流程。
* **Scope**: 僅描述架構、流程、安全、頁面與營運模型；不包含原始碼、部署指令或 API 實作範例。
