---
okf_version: "0.1"
---
# Threads 變形帳號防護：自助式架構知識包

# 系統

* [系統總覽](system-overview.md) - 說明自助登入、Threads 連線、變形帳號偵測、人工確認與封鎖的整體架構。
* [範圍與設計原則](scope-and-principles.md) - 定義系統要做與不做的事，以及所有高風險動作必須遵守的原則。
* [實作完成度審核](implementation-audit.md) - 追蹤 OKF 與目前實作的差異、待驗證項目及已知缺口。

# 架構

* [元件模型](architecture/component-model.md) - 定義使用者介面、控制平面、瀏覽器執行平面與資料服務的責任。
* [部署拓樸](architecture/deployment-topology.md) - 劃分使用者、GitHub Actions、Cloudflare、Meta lifecycle callback 與 Threads 的部署及信任邊界。
* [身分與多租戶](architecture/identity-and-tenancy.md) - 分離應用程式身分與 Threads 身分，並確保每位使用者的資料與工作階段隔離。
* [OAuth 憑證與瀏覽器工作階段](architecture/browser-session-architecture.md) - 描述官方 OAuth token、人工交接、更新、撤銷與刪除。
* [端到端資料流](architecture/data-flows.md) - 說明註冊、連線、掃描、審核、封鎖與中斷連線的資料流。
* [候選偵測](architecture/candidate-detection.md) - 定義有限變形產生、相似度訊號與人工判斷邏輯。

# 使用者體驗

* [使用者旅程](experience/user-journey.md) - 從登入服務到完成單一封鎖的完整操作旅程。
* [畫面架構](experience/screen-architecture.md) - 定義可操作網頁所需的主要頁面與資訊層級。
* [封鎖批准流程](experience/block-approval-flow.md) - 定義封鎖前確認、再驗證、執行與結果呈現。

# 安全與隱私

* [安全架構](security/security-architecture.md) - 保護帳號工作階段、證據、管理動作與租戶邊界。
* [隱私與同意](security/privacy-and-consent.md) - 定義告知、授權、資料保留、刪除與撤銷。
* [威脅模型](security/threat-model.md) - 列出工作階段竊取、跨租戶存取、誤封與平台挑戰等風險。

# 營運

* [營運模型](operations/operational-model.md) - 定義掃描排程、工作狀態、通知、稽核與人工介入。
* [故障模型](operations/failure-model.md) - 定義登入失效、頁面變更、挑戰頁面與結果不明時的保守處置。
* [容量與平台限制](operations/capacity-and-platform-constraints.md) - 記錄 Browser Run、Live View 與外部平台限制對架構的影響。

# 決策與參考

* [架構決策](decisions/architecture-decisions.md) - 記錄自助登入、多租戶隔離與單一目標批准等核心取捨。
* [平台能力與限制](references/platform-capabilities.md) - 整理 OKF、Cloudflare Browser Run 與 Threads 官方能力的架構假設。
