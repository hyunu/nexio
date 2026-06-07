import { useState, useEffect } from 'react';
import BoardConsole from './BoardConsole';

const API_BASE = 'http://localhost:10008/api';

interface Board {
  id: string;
  uniqueId: string;
  macAddress: string;
  status: string;
  connectedAt: string;
  updatedAt: string;
  location?: string;
  productConnected?: boolean;
}

interface SessionItem {
  id: string;
  boardId: string;
  clientId: string;
  assignedAt: string;
  expiresAt: string;
  status: string;
  board: { uniqueId: string };
  client: { clientId: string };
}

interface Client {
  id: string;
  clientId: string;
  userId: string;
  status: string;
  connectedAt: string;
  updatedAt: string;
}

interface User {
  id: string;
  username: string;
  email: string;
  orgName: string;
  active: boolean;
  clientId: string;
  createdAt: string;
}

const statusLabel: Record<string, string> = {
  IDLE: '대기', BUSY: '사용 중', OFFLINE: '오프라인',
  DISCARDED: '폐기됨', CLAIMED: '할당됨',
  CONNECTED: '연결됨', DISCONNECTED: '연결 끊김',
};

const statusColor: Record<string, string> = {
  IDLE: '#10b981', BUSY: '#f59e0b', OFFLINE: '#ef4444',
  DISCARDED: '#6b7280', CLAIMED: '#8b5cf6',
  CONNECTED: '#10b981', DISCONNECTED: '#ef4444',
};

const statusDescriptions: Record<string, string> = {
  IDLE: '서버에 연결되어 있으며 세션을 기다리는 상태',
  BUSY: '릴레이 모듈이 현재 세션에서 사용 중인 상태',
  OFFLINE: '서버와 연결이 끊긴 상태 (타임아웃 또는 보드 재시작)',
  DISCARDED: '공장 초기화되어 모든 설정이 지워진 상태. BLE로 새로 온보딩 필요',
  CLAIMED: '폰에서 고유 ID를 할당받았으나 아직 REGISTER 메시지를 보내지 않음',
};

const sidebarNav = [
  { key: 'boards', label: '릴레이 모듈', icon: '◈' },
  { key: 'sessions', label: '세션', icon: '◈' },
  { key: 'clients', label: '클라이언트', icon: '◈' },
  { key: 'users', label: '사용자', icon: '◉' },
];

function App() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [selectedBoard, setSelectedBoard] = useState('');
  const [selectedClient, setSelectedClient] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [tab, setTab] = useState<'boards' | 'sessions' | 'clients' | 'users'>('boards');
  const [consoleBoard, setConsoleBoard] = useState<string | null>(null);
  const [editingLocation, setEditingLocation] = useState<Record<string, string>>({});
  const [savingLocation, setSavingLocation] = useState<Record<string, boolean>>({});
  const [showStatusInfo, setShowStatusInfo] = useState(false);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  async function fetchData() {
    try {
      const [boardsRes, clientsRes, usersRes, sessionsRes] = await Promise.all([
        fetch(`${API_BASE}/boards`),
        fetch(`${API_BASE}/clients`),
        fetch(`${API_BASE}/users`),
        fetch(`${API_BASE}/sessions`),
      ]);
      setBoards(await boardsRes.json());
      setClients(await clientsRes.json());
      setUsers(await usersRes.json());
      setSessions(await sessionsRes.json());
    } catch (err) {
      console.error('Fetch error:', err);
    }
  }

  async function createSession() {
    if (!selectedBoard || !selectedClient) {
      setMessage('보드와 클라이언트를 선택하세요');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boardId: selectedBoard, clientId: selectedClient, duration: 3600 }),
      });
      if (res.ok) {
        setMessage('세션이 생성되었습니다');
        fetchData();
      } else {
        const err = await res.json();
        setMessage(`오류: ${err.error}`);
      }
    } catch {
      setMessage('세션 생성 실패');
    }
    setLoading(false);
  }

  async function saveLocation(uniqueId: string) {
    const loc = editingLocation[uniqueId] ?? '';
    setSavingLocation(prev => ({ ...prev, [uniqueId]: true }));
    await fetch(`${API_BASE}/boards/${uniqueId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location: loc }),
    }).catch(() => {});
    setSavingLocation(prev => ({ ...prev, [uniqueId]: false }));
  }

  async function sendControl(targetId: string, action: string, type: string) {
    try {
      await fetch(`${API_BASE}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId, action, type }),
      });
      setMessage(`제어 명령 전송: ${action}`);
    } catch {
      setMessage('제어 명령 전송 실패');
    }
  }

  return (
    <>
      {consoleBoard && <BoardConsole boardId={consoleBoard} onClose={() => setConsoleBoard(null)} />}
      {!consoleBoard && (
        <div style={layoutStyle}>
          <aside style={sidebarStyle}>
            <div style={logoStyle}>NEXIO</div>
            <nav style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {sidebarNav.map(item => (
                <button
                  key={item.key}
                  style={navItemStyle(tab === item.key)}
                  onClick={() => setTab(item.key as typeof tab)}
                >
                  <span style={{ marginRight: 10 }}>{item.icon}</span>
                  {item.label}
                  {item.key === 'boards' && <span style={countStyle}>{boards.length}</span>}
                </button>
              ))}
            </nav>
          </aside>
          <main style={mainStyle}>
            <header style={headerStyle}>
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 300, color: '#1e293b', letterSpacing: 6 }}>넥시오 대시보드</h1>
              <span style={{ fontSize: 13, color: '#6b7280' }}>
                {new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })}
              </span>
            </header>

            {message && (
              <div style={{
                padding: '10px 16px',
                background: message.includes('오류') ? '#fef2f2' : '#f0fdf4',
                color: message.includes('오류') ? '#b91c1c' : '#166534',
                borderRadius: 8,
                marginBottom: 20,
                fontSize: 14,
                borderLeft: `4px solid ${message.includes('오류') ? '#ef4444' : '#10b981'}`,
              }}>
                {message}
              </div>
            )}

            {tab === 'boards' && (
              <div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  <div style={cardStyle}>
                    <div style={cardHeaderStyle}>
                      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>릴레이 모듈 ({boards.length})</h2>
                      <button
                        style={{ marginLeft: 'auto', padding: '4px 12px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', fontSize: 12, color: '#6b7280', cursor: 'pointer' }}
                        onClick={() => setShowStatusInfo(true)}
                      >상태 설명</button>
                    </div>

                    {showStatusInfo && (
                      <div style={{ padding: '12px 20px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb', fontSize: 13, color: '#374151' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <strong style={{ fontSize: 14 }}>릴레이 모듈 상태 설명</strong>
                          <button style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer', color: '#9ca3af', padding: 0 }} onClick={() => setShowStatusInfo(false)}>×</button>
                        </div>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <tbody>
                            {Object.entries(statusDescriptions).map(([key, desc]) => (
                              <tr key={key}>
                                <td style={{ padding: '4px 8px', width: 100 }}>
                                  <span style={badgeStyle(statusColor[key] || '#888')}>{statusLabel[key] || key}</span>
                                </td>
                                <td style={{ padding: '4px 8px', color: '#6b7280' }}>{desc}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    <table style={tableStyle}>
                      <thead>
                        <tr>
                          <th style={thStyle}>고유 ID</th>
                          <th style={thStyle}>상태</th>
                          <th style={thStyle}>연결상태</th>
                          <th style={thStyle}>설치장소</th>
                          <th style={thStyle}>연결 시간</th>
                          <th style={{ ...thStyle, textAlign: 'right' }}>작업</th>
                        </tr>
                      </thead>
                      <tbody>
                        {boards.map(board => (
                          <tr key={board.id} style={{ ...rowHoverStyle, opacity: board.status === 'DISCARDED' ? 0.5 : 1 }}>
                            <td style={tdStyle}>
                              <span style={{ fontFamily: 'monospace', fontWeight: 500 }}>{board.uniqueId}</span>
                            </td>
                            <td style={tdStyle}>
                              <span style={badgeStyle(statusColor[board.status] || '#888')}>
                                {statusLabel[board.status] || board.status}
                              </span>
                            </td>
                            <td style={tdStyle}>
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <span style={badgeStyle(board.status === 'OFFLINE' || board.status === 'DISCONNECTED' || board.status === 'DISCARDED' ? '#9ca3af' : '#22c55e')}>
                                  서버{board.status === 'OFFLINE' || board.status === 'DISCONNECTED' || board.status === 'DISCARDED' ? '✗' : '✓'}
                                </span>
                                <span style={badgeStyle(board.productConnected ? '#22c55e' : '#9ca3af')}>
                                  제품{board.productConnected ? '✓' : '✗'}
                                </span>
                              </div>
                            </td>
                            <td style={tdStyle}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <input
                                  style={{
                                    border: 'none',
                                    borderBottom: '1px solid #e5e7eb',
                                    padding: '2px 4px',
                                    fontSize: 13,
                                    width: 120,
                                    outline: 'none',
                                    background: 'transparent',
                                    color: '#374151',
                                  }}
                                  placeholder="설치장소 입력"
                                  value={editingLocation[board.uniqueId] ?? board.location ?? ''}
                                  onChange={e => setEditingLocation(prev => ({ ...prev, [board.uniqueId]: e.target.value }))}
                                  onBlur={() => saveLocation(board.uniqueId)}
                                  onKeyDown={e => { if (e.key === 'Enter') saveLocation(board.uniqueId); }}
                                />
                                {savingLocation[board.uniqueId] && <span style={{ fontSize: 11, color: '#9ca3af' }}>저장 중...</span>}
                              </div>
                            </td>
                            <td style={{ ...tdStyle, color: '#6b7280' }}>
                              {new Date(board.connectedAt).toLocaleString()}
                            </td>
                            <td style={{ ...tdStyle, textAlign: 'right' }}>
                              <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                                {board.status !== 'DISCARDED' && (
                                  <>
                                    <button style={btnStyle('#f59e0b')} onClick={() => sendControl(board.uniqueId, 'RESET', 'board')}>재시작</button>
                                    <button style={btnStyle('#3b82f6')} onClick={() => setConsoleBoard(board.uniqueId)}>콘솔</button>
                                  </>
                                )}
                                <button style={btnStyle(board.status === 'DISCARDED' ? '#6b7280' : '#ef4444')} onClick={async () => {
                                  if (board.status === 'DISCARDED') return;
                                  await fetch(`${API_BASE}/boards/${board.uniqueId}/discard`, { method: 'POST' });
                                  fetchData();
                                }}>{board.status === 'DISCARDED' ? '삭제' : '공장 초기화'}</button>
                              </div>
                            </td>
                          </tr>
                        ))}
                          {boards.length === 0 && (
                          <tr><td colSpan={6} style={{ ...tdStyle, textAlign: 'center', color: '#9ca3af', padding: 32 }}>릴레이 모듈이 없습니다</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {tab === 'sessions' && (
              <>
                <div style={cardStyle}>
                  <div style={cardHeaderStyle}>
                    <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>세션 생성</h2>
                  </div>
                  <div style={{ padding: 16, display: 'flex', gap: 10, alignItems: 'center' }}>
                    <select style={selectStyle} value={selectedBoard} onChange={(e) => setSelectedBoard(e.target.value)}>
                      <option value="">릴레이 모듈 선택</option>
                      {boards.filter(b => b.status === 'IDLE').map(board => (
                        <option key={board.id} value={board.uniqueId}>{board.uniqueId}</option>
                      ))}
                    </select>
                    <select style={selectStyle} value={selectedClient} onChange={(e) => setSelectedClient(e.target.value)}>
                      <option value="">클라이언트 선택</option>
                      {clients.map(client => (
                        <option key={client.id} value={client.clientId}>{client.clientId}</option>
                      ))}
                    </select>
                    <button style={primaryBtnStyle} onClick={createSession} disabled={loading || !selectedBoard || !selectedClient}>
                      {loading ? '생성 중...' : '연결'}
                    </button>
                  </div>
                </div>
                <div style={{ ...cardStyle, marginTop: 20 }}>
                  <div style={cardHeaderStyle}>
                    <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>세션 목록 ({sessions.length})</h2>
                  </div>
                  <table style={tableStyle}>
                    <thead>
                      <tr>
                        <th style={thStyle}>보드</th>
                        <th style={thStyle}>클라이언트</th>
                        <th style={thStyle}>상태</th>
                        <th style={thStyle}>시작</th>
                        <th style={thStyle}>만료</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sessions.map(s => (
                        <tr key={s.id} style={rowHoverStyle}>
                          <td style={{ ...tdStyle, fontFamily: 'monospace' }}>{s.board.uniqueId}</td>
                          <td style={{ ...tdStyle, fontFamily: 'monospace' }}>{s.client.clientId}</td>
                          <td style={tdStyle}>
                            <span style={badgeStyle(s.status === 'ACTIVE' ? '#10b981' : '#9ca3af')}>
                              {s.status === 'ACTIVE' ? '활성' : '종료'}
                            </span>
                          </td>
                          <td style={{ ...tdStyle, color: '#6b7280' }}>{new Date(s.assignedAt).toLocaleString()}</td>
                          <td style={{ ...tdStyle, color: '#6b7280' }}>{new Date(s.expiresAt).toLocaleString()}</td>
                        </tr>
                      ))}
                      {sessions.length === 0 && (
                        <tr><td colSpan={5} style={{ ...tdStyle, textAlign: 'center', color: '#9ca3af', padding: 32 }}>세션이 없습니다</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {tab === 'clients' && (
              <div style={cardStyle}>
                <div style={cardHeaderStyle}>
                  <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>클라이언트 ({clients.length})</h2>
                </div>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>클라이언트 ID</th>
                      <th style={thStyle}>사용자</th>
                      <th style={thStyle}>상태</th>
                      <th style={thStyle}>작업</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clients.map(client => (
                      <tr key={client.id} style={rowHoverStyle}>
                        <td style={{ ...tdStyle, fontFamily: 'monospace' }}>{client.clientId}</td>
                        <td style={tdStyle}>{client.userId ? client.userId.substring(0, 8) : '-'}</td>
                        <td style={tdStyle}>
                          <span style={badgeStyle(statusColor[client.status] || '#888')}>
                            {statusLabel[client.status] || client.status}
                          </span>
                        </td>
                        <td style={tdStyle}>
                          <button style={btnStyle('#ef4444')} onClick={() => sendControl(client.clientId, 'DISCONNECT', 'client')}>연결 끊기</button>
                        </td>
                      </tr>
                    ))}
                    {clients.length === 0 && (
                      <tr><td colSpan={4} style={{ ...tdStyle, textAlign: 'center', color: '#9ca3af', padding: 32 }}>연결된 클라이언트가 없습니다</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {tab === 'users' && (
              <div style={cardStyle}>
                <div style={cardHeaderStyle}>
                  <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>사용자 ({users.length})</h2>
                </div>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>사용자명</th>
                      <th style={thStyle}>이메일</th>
                      <th style={thStyle}>기관</th>
                      <th style={thStyle}>활성</th>
                      <th style={thStyle}>클라이언트</th>
                      <th style={thStyle}>가입일</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map(user => (
                      <tr key={user.id} style={rowHoverStyle}>
                        <td style={{ ...tdStyle, fontWeight: 600 }}>{user.username}</td>
                        <td style={tdStyle}>{user.email || '-'}</td>
                        <td style={tdStyle}>{user.orgName || '-'}</td>
                        <td style={tdStyle}>
                          <button
                            style={toggleBtnStyle(user.active)}
                            onClick={async () => {
                              await fetch(`${API_BASE}/users/${user.id}/toggle`, { method: 'POST' });
                              fetchData();
                            }}
                          >
                            {user.active ? '활성' : '비활성'}
                          </button>
                        </td>
                        <td style={{ ...tdStyle, fontFamily: 'monospace', color: '#6b7280' }}>
                          {user.clientId ? `${user.clientId.substring(0, 16)}...` : '-'}
                        </td>
                        <td style={{ ...tdStyle, color: '#6b7280' }}>{new Date(user.createdAt).toLocaleDateString()}</td>
                      </tr>
                    ))}
                    {users.length === 0 && (
                      <tr><td colSpan={6} style={{ ...tdStyle, textAlign: 'center', color: '#9ca3af', padding: 32 }}>등록된 사용자가 없습니다</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </main>
        </div>
      )}
    </>
  );
}

const layoutStyle: React.CSSProperties = {
  display: 'flex',
  height: '100vh',
  background: '#f3f4f6',
  fontFamily: "'Noto Sans KR', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
};

const sidebarStyle: React.CSSProperties = {
  width: 220,
  background: '#1e293b',
  padding: '24px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 24,
};

const logoStyle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 800,
  color: '#fff',
  letterSpacing: 4,
  padding: '0 12px',
};

const navItemStyle = (active: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  padding: '10px 14px',
  border: 'none',
  borderRadius: 8,
  background: active ? 'rgba(255,255,255,0.1)' : 'transparent',
  color: active ? '#fff' : '#94a3b8',
  fontSize: 14,
  fontWeight: active ? 600 : 400,
  cursor: 'pointer',
  textAlign: 'left',
  transition: 'all 0.15s',
});

const countStyle: React.CSSProperties = {
  marginLeft: 'auto',
  background: 'rgba(255,255,255,0.15)',
  color: '#fff',
  fontSize: 11,
  fontWeight: 600,
  padding: '1px 8px',
  borderRadius: 10,
};

const mainStyle: React.CSSProperties = {
  flex: 1,
  overflow: 'auto',
  padding: 24,
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 24,
};

const cardStyle: React.CSSProperties = {
  background: '#fff',
  borderRadius: 12,
  overflow: 'hidden',
  boxShadow: '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
};

const cardHeaderStyle: React.CSSProperties = {
  padding: '16px 20px',
  borderBottom: '1px solid #f3f4f6',
  display: 'flex',
  alignItems: 'center',
};

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
};

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 20px',
  fontSize: 12,
  fontWeight: 600,
  color: '#6b7280',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  background: '#f9fafb',
  borderBottom: '1px solid #e5e7eb',
};

const tdStyle: React.CSSProperties = {
  padding: '12px 20px',
  fontSize: 14,
  borderBottom: '1px solid #f3f4f6',
};

const rowHoverStyle: React.CSSProperties = {
  transition: 'background 0.1s',
};

const badgeStyle = (color: string): React.CSSProperties => ({
  display: 'inline-block',
  padding: '3px 10px',
  borderRadius: 20,
  fontSize: 12,
  fontWeight: 600,
  color: '#fff',
  background: color,
});

const btnStyle = (color: string): React.CSSProperties => ({
  padding: '5px 12px',
  border: 'none',
  borderRadius: 6,
  background: color,
  color: '#fff',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
  opacity: 0.9,
  transition: 'opacity 0.15s',
});

const primaryBtnStyle: React.CSSProperties = {
  padding: '8px 20px',
  border: 'none',
  borderRadius: 8,
  background: '#3b82f6',
  color: '#fff',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'background 0.15s',
};

const selectStyle: React.CSSProperties = {
  padding: '8px 12px',
  border: '1px solid #d1d5db',
  borderRadius: 8,
  fontSize: 14,
  minWidth: 160,
  background: '#fff',
  color: '#111827',
};

const toggleBtnStyle = (active: boolean): React.CSSProperties => ({
  padding: '4px 14px',
  border: 'none',
  borderRadius: 20,
  background: active ? '#10b981' : '#ef4444',
  color: '#fff',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  minWidth: 60,
});

export default App;
