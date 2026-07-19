import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
} from 'react-router-dom';

import { api, ApiError } from './api';
import type {
  ActivityEvent,
  Candidate,
  Capabilities,
  Connection,
  Identity,
  SchedulePreference,
} from './api';

const STATUS_LABELS: Record<Connection['status'], string> = {
  awaiting_identity_confirmation: '等待確認',
  connected: '已連線',
  reauth_required: '需要重新登入',
  challenge_required: '需要本人處理',
  revoking: '正在中斷',
  revoked: '已撤銷',
};

const NAVIGATION = [
  { to: '/', label: '儀表板', glyph: '◫', end: true },
  { to: '/candidates', label: '候選帳號', glyph: '◎' },
  { to: '/activity', label: '活動紀錄', glyph: '≋' },
  { to: '/connections', label: '連線', glyph: '↗' },
  { to: '/settings', label: '設定', glyph: '◇' },
] as const;

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-TW', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function PageHeader({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
      </div>
      {children}
    </header>
  );
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <section className="empty-state">
      <span className="empty-mark">◎</span>
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </section>
  );
}

function Layout({
  identity,
  connection,
  children,
}: {
  identity: Identity;
  connection?: Connection;
  children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" to="/" aria-label="Threads Variant Guard 首頁">
          <span className="brand-mark">T</span>
          <span>
            Variant Guard
            <small>Threads 防護</small>
          </span>
        </Link>
        <nav aria-label="主要導覽">
          {NAVIGATION.map((item) => (
            <NavLink key={item.to} to={item.to} end={'end' in item ? item.end : false}>
              <span aria-hidden="true">{item.glyph}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="avatar">{identity.email?.slice(0, 1).toUpperCase() ?? 'U'}</span>
          <span>
            {identity.email ?? '已驗證使用者'}
            <small>Cloudflare Access</small>
          </span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div>
            <span className="topbar-label">目前保護</span>
            <strong>{connection ? `@${connection.protectedUsername}` : '尚未選擇帳號'}</strong>
          </div>
          <span className={`health ${connection?.status === 'connected' ? 'healthy' : ''}`}>
            <i /> {connection ? STATUS_LABELS[connection.status] : '尚未連線'}
          </span>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

function Dashboard({ connections, candidates }: { connections: Connection[]; candidates: Candidate[] }) {
  const highPriority = candidates.filter(({ priority }) => priority === 'high').length;
  const watching = candidates.filter(({ status }) => status === 'watching').length;

  return (
    <>
      <PageHeader eyebrow="Overview" title="今天的帳號狀況" />
      {connections.length === 0 ? (
        <EmptyState
          title="先建立受保護帳號"
          body="這只會建立本服務內的連線草稿；下一步才會透過官方 OAuth 連線 Threads。"
          action={<Link className="button primary" to="/connections">開始設定</Link>}
        />
      ) : (
        <>
          <section className="metric-grid" aria-label="候選摘要">
            <article>
              <span>候選總數</span>
              <strong>{candidates.length}</strong>
              <small>有限規則與人工目標</small>
            </article>
            <article>
              <span>高優先</span>
              <strong>{highPriority}</strong>
              <small>只代表應優先人工審核</small>
            </article>
            <article>
              <span>監看中</span>
              <strong>{watching}</strong>
              <small>依低頻策略重新檢查</small>
            </article>
          </section>
          <section className="split-grid">
            <article className="panel focus-panel">
              <p className="eyebrow">Review queue</p>
              <h2>審核，而不是定罪。</h2>
              <p>候選名稱相似只是一個線索。查看完整名稱與證據後，再決定忽略、監看或準備單一封鎖。</p>
              <Link className="text-link" to="/candidates">開啟候選清單 →</Link>
            </article>
            <article className="panel safety-list">
              <h2>安全邊界</h2>
              <ul>
                <li><i /> 排程不會自動封鎖</li>
                <li><i /> 不收集 Threads 密碼或 Cookie</li>
                <li><i /> 結果不明時禁止自動重試</li>
              </ul>
            </article>
          </section>
        </>
      )}
    </>
  );
}

function CandidateList({
  connection,
  candidates,
  canManualHandoff,
  onRefresh,
}: {
  connection?: Connection;
  candidates: Candidate[];
  canManualHandoff: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [pendingHandoff, setPendingHandoff] = useState<{
    id: string;
    exactTargetUsername: string;
  } | null>(() => {
    if (typeof window === 'undefined') return null;
    const value = window.sessionStorage.getItem('pending-block-handoff');
    if (!value) return null;
    try {
      return JSON.parse(value) as { id: string; exactTargetUsername: string };
    } catch {
      return null;
    }
  });

  async function generate() {
    if (!connection) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await api.generateCandidates(connection.id);
      setMessage(`快照產生 ${result.snapshot.generated} 個候選，其中 ${result.snapshot.created} 個為新項目。`);
      await onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '無法產生候選。');
    } finally {
      setBusy(false);
    }
  }

  async function addManual(event: FormEvent) {
    event.preventDefault();
    if (!connection || !username.trim()) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await api.addCandidate(connection.id, username);
      setUsername('');
      setMessage('已加入一個明確候選帳號。');
      await onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '無法加入候選。');
    } finally {
      setBusy(false);
    }
  }

  async function decide(candidateId: string, action: 'watch' | 'ignore' | 'resume') {
    if (!connection) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await api.decideCandidate(connection.id, candidateId, action);
      setMessage(
        action === 'ignore'
          ? '已忽略這個候選。'
          : action === 'resume'
            ? '已恢復監看這個候選。'
            : '已將這個候選加入監看。',
      );
      await onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '無法儲存候選決定。');
    } finally {
      setBusy(false);
    }
  }

  async function refreshCandidate(candidateId: string) {
    if (!connection) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await api.refreshCandidate(connection.id, candidateId);
      setMessage('已更新這個候選的官方公開資料與審核優先級。');
      await onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '目前無法更新候選。');
    } finally {
      setBusy(false);
    }
  }

  async function startBlockHandoff(candidate: Candidate) {
    if (
      !connection ||
      !window.confirm(
        `即將開啟人工操作，只核准目標 @${candidate.username}。這不是自動封鎖，且結果不明時不會重試。是否繼續？`,
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const issued = await api.issueApproval(connection.id, candidate.id, candidate.username);
      const started = await api.startHandoff(issued.approval.id, issued.actionToken);
      const pending = {
        id: started.handoff.id,
        exactTargetUsername: started.handoff.exactTargetUsername,
      };
      window.sessionStorage.setItem('pending-block-handoff', JSON.stringify(pending));
      setPendingHandoff(pending);
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = started.handoff.enterPath;
      form.hidden = true;
      document.documentElement.appendChild(form);
      form.submit();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '無法建立安全人工交接。');
      setBusy(false);
    }
  }

  async function completeHandoff() {
    if (!pendingHandoff) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const { result } = await api.completeHandoff(pendingHandoff.id);
      window.sessionStorage.removeItem('pending-block-handoff');
      setPendingHandoff(null);
      setMessage(
        result.status === 'confirmed_success'
          ? `已確認 @${result.exactTargetUsername} 的人工操作結果。`
          : `@${result.exactTargetUsername} 的結果不明，已停止且不會重試，請人工複查。`,
      );
      await onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '無法驗證人工操作結果。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader eyebrow="Review queue" title="候選帳號">
        {connection ? (
          <button className="button primary" disabled={busy} onClick={() => void generate()}>
            {busy ? '處理中…' : '產生有限候選'}
          </button>
        ) : undefined}
      </PageHeader>
      {!connection ? (
        <EmptyState
          title="尚未建立受保護帳號"
          body="建立帳號草稿後，候選規則才有明確且受限的基準。"
          action={<Link className="button primary" to="/connections">前往連線</Link>}
        />
      ) : (
        <>
          <form className="inline-form panel" onSubmit={(event) => void addManual(event)}>
            <label htmlFor="manual-candidate">
              人工加入已知帳號
              <small>只接受一個完整 username，不支援搜尋或萬用字元。</small>
            </label>
            <div>
              <input
                id="manual-candidate"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="@suspected.account"
                autoComplete="off"
              />
              <button className="button secondary" disabled={busy} type="submit">加入</button>
            </div>
          </form>
          {pendingHandoff ? (
            <section className="panel handoff-return" role="status">
              <div>
                <strong>人工操作：@{pendingHandoff.exactTargetUsername}</strong>
                <small>完成 Live View 後回到這裡，只會驗證結果，不會再次執行。</small>
              </div>
              <button
                className="button primary"
                type="button"
                disabled={busy}
                onClick={() => void completeHandoff()}
              >
                已完成，驗證結果
              </button>
            </section>
          ) : null}
          {message ? <p className="notice" role="status">{message}</p> : null}
          {candidates.length === 0 ? (
            <EmptyState title="目前沒有候選" body="你可以產生受限變形，或人工加入一個已知完整帳號。" />
          ) : (
            <section className="candidate-list" aria-label="候選帳號清單">
              {candidates.map((candidate) => (
                <article key={candidate.id} className="candidate-card">
                  <div className="candidate-avatar">@</div>
                  <div className="candidate-main">
                    <div>
                      <h2>@{candidate.username}</h2>
                      <span className={`priority ${candidate.priority}`}>{candidate.priority === 'high' ? '高' : candidate.priority === 'medium' ? '中' : '低'}優先</span>
                    </div>
                    <p>{candidate.reasons[0] ?? '使用者人工加入'}</p>
                    <small>{candidate.sourceType === 'manual' ? '人工目標' : candidate.sourceRules.join('、')} · {formatDate(candidate.firstSeenAt)}</small>
                  </div>
                  <div className="candidate-actions">
                    {candidate.status === 'ignored' ? (
                      <button
                        className="button ghost"
                        type="button"
                        disabled={busy}
                        onClick={() => void decide(candidate.id, 'resume')}
                      >
                        恢復監看
                      </button>
                    ) : candidate.status === 'new' ? (
                      <button
                        className="button ghost"
                        type="button"
                        disabled={busy || connection.status !== 'connected'}
                        onClick={() => void refreshCandidate(candidate.id)}
                      >
                        {connection.status === 'connected' ? '載入證據' : '等待連線'}
                      </button>
                    ) : ['pending_review', 'watching', 'not_found', 'lookup_unavailable'].includes(
                        candidate.status,
                      ) ? (
                      <>
                        {candidate.status !== 'watching' ? (
                          <button
                            className="button ghost"
                            type="button"
                            disabled={busy}
                            onClick={() => void decide(candidate.id, 'watch')}
                          >
                            持續監看
                          </button>
                        ) : null}
                        {['pending_review', 'watching'].includes(candidate.status) ? (
                          <>
                            <button
                              className="button ghost"
                              type="button"
                              disabled={busy}
                              onClick={() => void decide(candidate.id, 'ignore')}
                            >
                              忽略
                            </button>
                            {canManualHandoff ? (
                              <button
                                className="button danger"
                                type="button"
                                disabled={busy}
                                onClick={() => void startBlockHandoff(candidate)}
                              >
                                人工封鎖此帳號
                              </button>
                            ) : null}
                          </>
                        ) : null}
                      </>
                    ) : (
                      <button className="button ghost" type="button" disabled>等待掃描</button>
                    )}
                  </div>
                </article>
              ))}
            </section>
          )}
        </>
      )}
    </>
  );
}

function Connections({ connections, onCreated }: { connections: Connection[]; onCreated: () => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('oauth');
    if (!result) return;
    setMessage(
      result === 'pending_confirmation'
        ? 'Threads 已授權；請核對下方官方帳號後完成確認。'
        : result === 'cancelled'
          ? '你已取消 Threads 授權，沒有保存新憑證。'
          : 'Threads 授權未完成，請重新開始。',
    );
    window.history.replaceState({}, '', '/connections');
    void onCreated();
  }, [onCreated]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!username.trim()) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await api.createConnection(username);
      setUsername('');
      setMessage('帳號草稿已建立。OAuth 尚未完成前，不會執行任何平台查詢。');
      await onCreated();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '無法建立帳號。');
    } finally {
      setBusy(false);
    }
  }

  async function startOAuth(connectionId: string) {
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await api.startOAuth(connectionId);
      window.location.assign(result.authorizationUrl);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '目前無法開始 Threads OAuth。');
      setBusy(false);
    }
  }

  async function confirmOAuth(connection: Connection) {
    setBusy(true);
    setMessage(undefined);
    try {
      await api.confirmOAuth(connection.id, connection.protectedUsername);
      setMessage(`已確認並開始保護 @${connection.protectedUsername}。`);
      await onCreated();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '目前無法確認 Threads 身分。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader eyebrow="Connections" title="Threads 連線" />
      <section className="connection-grid">
        <form className="panel connection-form" onSubmit={(event) => void submit(event)}>
          <span className="step-number">01</span>
          <h2>建立受保護帳號草稿</h2>
          <p>輸入公開 username 只用於建立有限候選基準。正式帳號仍須由官方 Threads OAuth 回傳後再次確認。</p>
          <label htmlFor="protected-username">Threads username</label>
          <input
            id="protected-username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="@your.account"
            autoComplete="off"
          />
          <button className="button primary" disabled={busy} type="submit">
            {busy ? '建立中…' : '建立草稿'}
          </button>
          {message ? <p className="notice" role="status">{message}</p> : null}
        </form>
        <aside className="panel boundary-card">
          <p className="eyebrow">Credential boundary</p>
          <h2>我們不會向你索取</h2>
          <ul>
            <li>Threads 密碼</li>
            <li>雙重驗證碼</li>
            <li>Cookie 或 Session 檔</li>
            <li>瀏覽器 Profile</li>
          </ul>
        </aside>
      </section>
      {connections.length > 0 ? (
        <section className="connection-list">
          <h2>帳號草稿</h2>
          {connections.map((connection) => (
            <article key={connection.id} className="panel connection-row">
              <div className="connection-symbol">T</div>
              <div>
                <strong>@{connection.protectedUsername}</strong>
                <small>建立於 {formatDate(connection.createdAt)}</small>
              </div>
              <span className="status-pill">{STATUS_LABELS[connection.status]}</span>
              {connection.status === 'awaiting_identity_confirmation' ? (
                connection.platformUserId ? (
                  <button
                    className="button primary"
                    type="button"
                    disabled={busy}
                    onClick={() => void confirmOAuth(connection)}
                  >
                    確認保護 @{connection.protectedUsername}
                  </button>
                ) : (
                  <button
                    className="button secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => void startOAuth(connection.id)}
                  >
                    連線 Threads OAuth
                  </button>
                )
              ) : null}
            </article>
          ))}
        </section>
      ) : null}
    </>
  );
}

const EVENT_LABELS: Record<string, string> = {
  'tenant.created': '安全工作區已建立',
  'connection.created': 'Threads 連線草稿已建立',
  'connection.identity_confirmed': 'Threads 帳號身分已確認',
  'connection.revoked': 'Threads 連線已撤銷',
  'candidate.added': '已人工加入候選',
  'candidate.generated': '已產生有限候選',
  'candidate.lookup_completed': '候選個人檔案已更新',
  'candidate.decision': '候選審核決定已儲存',
  'approval.issued': '單一目標批准已簽發',
  'evidence.created': '私有證據已保存',
  'evidence.deleted': '私有證據已刪除',
};

function Activity({ events }: { events: ActivityEvent[] }) {
  return (
    <>
      <PageHeader eyebrow="Audit trail" title="活動紀錄" />
      <section className="panel activity-intro">
        <span className="empty-mark">≋</span>
        <div>
          <h2>安全事件會留下最小稽核</h2>
          <p>連線、候選決策、證據存取、批准與撤銷都會記錄內部識別與時間；不會記錄密碼、token、Cookie 或 Live View URL。</p>
        </div>
      </section>
      {events.length === 0 ? (
        <EmptyState title="尚無活動" body="建立連線或審核候選後，最小稽核會顯示在這裡。" />
      ) : (
        <section className="activity-list" aria-label="活動紀錄清單">
          {events.map((event) => (
            <article className="panel activity-row" key={event.id}>
              <span className="activity-mark">≋</span>
              <div>
                <strong>{EVENT_LABELS[event.eventType] ?? '安全活動已記錄'}</strong>
                <small>
                  {event.targetRef ? `${event.targetRef} · ` : ''}
                  {formatDate(event.createdAt)}
                </small>
              </div>
            </article>
          ))}
        </section>
      )}
    </>
  );
}

function Settings({
  connection,
  onConnectionChanged,
}: {
  connection?: Connection;
  onConnectionChanged: () => Promise<void>;
}) {
  const [schedule, setSchedule] = useState<SchedulePreference>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!connection) return;
    void api
      .schedule(connection.id)
      .then(({ schedule: value }) => setSchedule(value))
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : '無法載入排程。');
      });
  }, [connection]);

  async function toggleSchedule() {
    if (!connection || !schedule) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const timezone =
        schedule.timezone === 'UTC'
          ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
          : schedule.timezone;
      const result = await api.updateSchedule(connection.id, !schedule.enabled, timezone);
      setSchedule(result.schedule);
      setMessage(result.schedule.enabled ? '已啟用低頻每日刷新。' : '已停用所有排程刷新。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '無法更新排程。');
    } finally {
      setBusy(false);
    }
  }

  async function revokeConnection(dataRetention: 'retain' | 'delete') {
    if (!connection) return;
    const explanation =
      dataRetention === 'delete'
        ? '這會中斷 Threads 連線、刪除候選、快照與私有證據；撤銷稽核仍會保留。'
        : '這會中斷 Threads 連線並刪除可再次使用的憑證；候選與歷史案件紀錄會保留。';
    if (!window.confirm(`${explanation}\n\n確定要中斷 @${connection.protectedUsername}？`)) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await api.revokeConnection(connection.id, dataRetention);
      setMessage('Threads 連線已撤銷，所有新工作與排程都已停止。');
      await onConnectionChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '目前無法安全中斷連線。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader eyebrow="Privacy controls" title="資料與設定" />
      <section className="settings-grid">
        <article className="panel schedule-card">
          <span>低頻排程</span>
          <h2>{schedule?.enabled ? '每日刷新已啟用' : '預設保持停用'}</h2>
          <p>
            只更新既有候選的公開資料，不建立批准，也不執行封鎖。
            {schedule?.nextRunAt ? ` 下次預計：${formatDate(schedule.nextRunAt)}。` : ''}
          </p>
          <button
            className="button secondary"
            type="button"
            disabled={busy || !schedule || connection?.status !== 'connected'}
            onClick={() => void toggleSchedule()}
          >
            {schedule?.enabled ? '停用排程' : '啟用每日刷新'}
          </button>
          {message ? <small className="notice">{message}</small> : null}
        </article>
        <article className="panel"><span>證據保留</span><h2>私有且可刪除</h2><p>R2 不提供公開網址；每次存取重新授權，超過保留期後清理。</p></article>
        <article className="panel"><span>平台動作</span><h2>逐一人工批准</h2><p>沒有全選封鎖；每個目標都需要最新證據、近期再驗證與一次性批准。</p></article>
        <article className="panel revoke-card">
          <span>中斷連線</span>
          <h2>立即銷毀 Threads 憑證</h2>
          <p>兩種選擇都會停止排程與工作；差別只在是否保留候選及案件證據。</p>
          <div>
            <button
              className="button secondary"
              type="button"
              disabled={busy || !connection || connection.status === 'revoked'}
              onClick={() => void revokeConnection('retain')}
            >
              中斷並保留紀錄
            </button>
            <button
              className="button danger"
              type="button"
              disabled={busy || !connection || connection.status === 'revoked'}
              onClick={() => void revokeConnection('delete')}
            >
              中斷並刪除資料
            </button>
          </div>
        </article>
      </section>
    </>
  );
}

function App() {
  const [identity, setIdentity] = useState<Identity>();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities>({
    officialProfileLookup: false,
    manualBlockHandoff: false,
    automatedBlock: false,
  });
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState<string>();

  const refreshConnections = useCallback(async () => {
    const result = await api.connections();
    setConnections(result.connections);
    return result.connections;
  }, []);

  const refreshCandidates = useCallback(async (connection?: Connection) => {
    if (!connection) {
      setCandidates([]);
      return;
    }
    const result = await api.candidates(connection.id);
    setCandidates(result.candidates);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const verifiedIdentity = await api.identity();
        const [connectionResult, activityResult, capabilityResult] = await Promise.all([
          api.connections(),
          api.activity(),
          api.capabilities(),
        ]);
        setIdentity(verifiedIdentity);
        setConnections(connectionResult.connections);
        setActivity(activityResult.events);
        setCapabilities(capabilityResult.capabilities);
        await refreshCandidates(connectionResult.connections[0]);
      } catch (error) {
        setFatalError(
          error instanceof ApiError && error.status === 401
            ? '請先透過 Cloudflare Access 登入本服務。'
            : error instanceof Error
              ? error.message
              : '目前無法載入服務。',
        );
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshCandidates]);

  async function connectionsChanged() {
    const updated = await refreshConnections();
    const nextConnection = updated.find(({ status }) => status !== 'revoked') ?? updated[0];
    await refreshCandidates(nextConnection);
  }

  if (loading) {
    return <div className="loading-screen"><span>T</span><p>正在建立安全工作區…</p></div>;
  }

  if (!identity || fatalError) {
    return (
      <div className="error-screen">
        <span className="brand-mark">T</span>
        <p className="eyebrow">Access required</p>
        <h1>無法開啟工作區</h1>
        <p>{fatalError ?? '請重新登入。'}</p>
        <button className="button primary" onClick={() => window.location.reload()}>重新載入</button>
      </div>
    );
  }

  const selectedConnection =
    connections.find(({ status }) => status !== 'revoked') ?? connections[0];

  return (
    <BrowserRouter>
      <Layout identity={identity} connection={selectedConnection}>
        <Routes>
          <Route path="/" element={<Dashboard connections={connections} candidates={candidates} />} />
          <Route path="/candidates" element={<CandidateList connection={selectedConnection} candidates={candidates} canManualHandoff={capabilities.manualBlockHandoff} onRefresh={() => refreshCandidates(selectedConnection)} />} />
          <Route path="/activity" element={<Activity events={activity} />} />
          <Route path="/connections" element={<Connections connections={connections} onCreated={connectionsChanged} />} />
          <Route path="/settings" element={<Settings connection={selectedConnection} onConnectionChanged={connectionsChanged} />} />
          <Route path="*" element={<Navigate replace to="/" />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

export default App;
