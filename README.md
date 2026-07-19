# Threads Variant Guard

自助式 Threads 變形帳號防護服務。系統使用有限且可解釋的候選規則協助帳號本人審核疑似相似帳號；排程不會自動批准或執行封鎖。

## 本機開發

需求：Node.js 22.12 以上或 24 以上。

```sh
npm install
npm run dev
```

完整品質檢查：

```sh
npm run check
```

健康檢查位於 `GET /api/health`。

## 安全邊界

- Threads 密碼、雙重驗證碼、Cookie 或 Session 檔不會由應用表單收集。
- 候選分數只決定審核順序，不會自動觸發封鎖。
- 每次封鎖都必須綁定一個近期重新確認的完整目標，且結果不明時不得自動重試。
