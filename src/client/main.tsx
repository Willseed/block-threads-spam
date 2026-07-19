import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

function App() {
  return (
    <main className="shell">
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">Threads Variant Guard</p>
        <h1 id="page-title">讓相似帳號的判斷，回到帳號本人手上。</h1>
        <p className="lede">
          以有限、可解釋的規則整理疑似變形帳號；掃描只負責找線索，任何封鎖都必須由你逐一確認。
        </p>
        <div className="principles" aria-label="服務原則">
          <article>
            <span>01</span>
            <h2>本人登入</h2>
            <p>Threads 密碼與雙重驗證資訊不進入本服務表單。</p>
          </article>
          <article>
            <span>02</span>
            <h2>證據優先</h2>
            <p>每個候選都說明來源規則、名稱差異與最近檢查時間。</p>
          </article>
          <article>
            <span>03</span>
            <h2>單一批准</h2>
            <p>沒有批次封鎖；每次只批准一個重新確認過的完整帳號。</p>
          </article>
        </div>
      </section>
    </main>
  );
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing root element');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
