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

## 應用程式登入

Production 預設以 Cloudflare Access 作為應用身分層。Worker 會自行驗證 `Cf-Access-Jwt-Assertion` 的 RS256 簽章、issuer 與 audience；只把不可變 `sub` 當成使用者識別。部署時必須設定：

- `TEAM_DOMAIN`：例如 `https://your-team.cloudflareaccess.com`
- `POLICY_AUD`：Access Application Audience tag

若未設定或驗證失敗，所有受保護的 `/api/*` 都會 fail closed；`/api/health` 保持公開供平台健康檢查。

## 候選產生原則

`generateCandidateVariants` 只執行單步、受控的視覺字元、標點、編輯與前後綴變形。呼叫端必須設定或接受總量與每規則配額；輸出會保留規則及繁體中文理由，且不會包含正式帳號本身。

`assessProfileSimilarity` 彙整使用者名稱、顯示名稱、頭像衍生分數、簡介與外部連結，輸出低／中／高「審核優先級」。分數只供排序，不能建立封鎖批准。

## 安全邊界

- Threads 密碼、雙重驗證碼、Cookie 或 Session 檔不會由應用表單收集。
- 候選分數只決定審核順序，不會自動觸發封鎖。
- 每次封鎖都必須綁定一個近期重新確認的完整目標，且結果不明時不得自動重試。
