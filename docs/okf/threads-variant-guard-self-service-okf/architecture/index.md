# 架構概念

* [元件模型](component-model.md) - 定義自助式介面、控制平面、執行平面與資料服務。
* [部署拓樸](deployment-topology.md) - 說明 GitHub Actions、Cloudflare、Meta lifecycle callback、使用者與 Threads 的信任邊界。
* [身分與多租戶](identity-and-tenancy.md) - 分離 Access 使用者、Threads OAuth 身分、Meta 系統 callback 與每位使用者的資料範圍。
* [OAuth 憑證與瀏覽器工作階段](browser-session-architecture.md) - 定義 token 加密、人工交接、撤銷與刪除生命週期。
* [端到端資料流](data-flows.md) - 描述使用者操作、Meta lifecycle 清理與 CI 部署機密資料流。
* [候選偵測](candidate-detection.md) - 定義有限變形、訊號、分數與審核狀態。
