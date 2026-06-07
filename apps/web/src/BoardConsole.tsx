import { useState, useEffect, useRef } from 'react';

// Resolve API/WS URLs relative to current origin so app works when served from server/container
const API_BASE = ((import.meta as any)?.env?.VITE_API_BASE as string) || '/api';
const WS_URL = (() => {
  try {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws/monitor`;
  } catch {
    return 'ws://localhost:10008/ws/monitor';
  }
})();

interface BoardDetail {
  board: {
    uniqueId: string;
    macAddress: string;
    status: string;
    firmwareVersion: string;
    connectedAt: string;
    updatedAt: string;
    location?: string;
    productConnected?: boolean;
  };
  logs: any[];
  connected: boolean;
}

interface LogEntry {
  id: number;
  timestamp: number;
  level: string;
  message: string;
  data?: any;
}

interface DataEntry {
  id: number;
  timestamp: number;
  direction: string;
  payload: string;
}

const levelColor: Record<string, string> = {
  error: '#ef4444',
  warn: '#f59e0b',
  info: '#22c55e',
  debug: '#94a3b8',
};

export default function BoardConsole({ boardId, onClose }: { boardId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<BoardDetail | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [dataRelays, setDataRelays] = useState<DataEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const logIdRef = useRef(0);
  const dataIdRef = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);
  const dataEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`${API_BASE}/boards/${boardId}`)
      .then(r => r.json())
      .then(d => {
        setDetail(d);
        setLogs((d.logs || []).map((l: any) => ({ ...l, id: ++logIdRef.current })));
      })
      .catch(() => {});
  }, [boardId]);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.boardId !== boardId) return;
        if (msg.type === 'LOG') {
          setLogs(prev => [...prev.slice(-499), { id: ++logIdRef.current, timestamp: msg.timestamp, level: msg.level, message: msg.message, data: msg.data }]);
        } else if (msg.type === 'DATA_RELAY') {
          setDataRelays(prev => [...prev.slice(-99), { id: ++dataIdRef.current, timestamp: msg.timestamp, direction: msg.direction, payload: msg.payload }]);
        }
      } catch {}
    };
    return () => ws.close();
  }, [boardId]);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [logs]);
  useEffect(() => { dataEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [dataRelays]);

  const statusLabel: Record<string, string> = {
    IDLE: '대기', BUSY: '사용 중', OFFLINE: '오프라인',
    CONNECTED: '연결됨', DISCONNECTED: '연결 끊김',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: "'NanumSquareRound', 'Pretendard', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", background: '#0f172a' }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '14px 24px', background: '#1e293b', color: '#fff',
        borderBottom: '1px solid #334155',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <strong style={{ fontSize: 16 }}>릴레이 모듈 {boardId}</strong>
          {detail && detail.board.location && (
            <span style={{ fontSize: 13, color: '#94a3b8' }}>
              <span style={{ color: '#64748b' }}>위치</span> {detail.board.location}
            </span>
          )}
          {detail && (
            <span style={{ fontSize: 13, color: '#94a3b8' }}>
              <span style={{ color: '#64748b' }}>MAC</span> {detail.board.macAddress || '-'}
              <span style={{ margin: '0 8px', color: '#475569' }}>|</span>
              <span style={{ color: '#64748b' }}>상태</span>{' '}
              <span style={{ color: '#fff', fontWeight: 500 }}>{statusLabel[detail.board.status] || detail.board.status}</span>
              <span style={{ margin: '0 8px', color: '#475569' }}>|</span>
              <span style={{ color: '#64748b' }}>제품</span>{' '}
              <span style={{ color: detail.board.productConnected ? '#3b82f6' : '#9ca3af', fontWeight: 500 }}>
                {detail.board.productConnected ? '연결' : '미연결'}
              </span>
              <span style={{ margin: '0 8px', color: '#475569' }}>|</span>
              {detail.connected && <span style={{ color: '#22c55e' }}>● WS</span>}
              <span style={{ color: connected ? '#22c55e' : '#ef4444', marginLeft: 6 }}>
                {connected ? '● 모니터' : '○ 모니터'}
              </span>
            </span>
          )}
        </div>
        <button onClick={onClose} style={{
          padding: '6px 16px', background: '#ef4444', color: '#fff', border: 'none',
          borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 500, opacity: 0.9,
        }}>닫기</button>
      </div>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid #334155' }}>
          <div style={{
            padding: '10px 16px', background: '#1e293b', borderBottom: '1px solid #334155',
            fontWeight: 600, fontSize: 13, color: '#e2e8f0', letterSpacing: '0.03em',
          }}>
            제품 데이터 교환
          </div>
          <div style={{
            flex: 1, overflow: 'auto', padding: 8, background: '#0f172a',
            fontFamily: 'D2Coding, JetBrains Mono, monospace', fontSize: 12, lineHeight: 1.7,
          }}>
            {dataRelays.length === 0 && (
              <div style={{ color: '#475569', padding: 12, fontSize: 13 }}>데이터 대기 중...</div>
            )}
            {dataRelays.map(d => (
              <div key={d.id} style={{ marginBottom: 4, padding: '2px 4px' }}>
                <span style={{ color: '#475569' }}>[{new Date(d.timestamp).toLocaleTimeString()}]</span>{' '}
                <span style={{ color: d.direction === 'B_TO_C' ? '#22d3ee' : '#f472b6', fontWeight: 600 }}>
                  {d.direction === 'B_TO_C' ? '← 보드' : '→ 클라이언트'}
                </span>{' '}
                <span style={{ color: '#cbd5e1' }}>
                  {d.payload?.substring(0, 200)}{(d.payload?.length || 0) > 200 ? '...' : ''}
                </span>
              </div>
            ))}
            <div ref={dataEndRef} />
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{
            padding: '10px 16px', background: '#1e293b', borderBottom: '1px solid #334155',
            fontWeight: 600, fontSize: 13, color: '#e2e8f0', letterSpacing: '0.03em',
          }}>
            로그 출력
          </div>
          <div style={{
            flex: 1, overflow: 'auto', padding: 8, background: '#0f172a',
            fontFamily: 'D2Coding, JetBrains Mono, monospace', fontSize: 12, lineHeight: 1.7,
          }}>
            {logs.length === 0 && (
              <div style={{ color: '#475569', padding: 12, fontSize: 13 }}>로그가 없습니다</div>
            )}
            {logs.map(l => (
              <div key={l.id} style={{ marginBottom: 2, padding: '1px 4px' }}>
                <span style={{ color: '#475569' }}>[{new Date(l.timestamp).toLocaleTimeString()}]</span>{' '}
                <span style={{ color: levelColor[l.level] || '#22c55e', fontWeight: 600 }}>
                  {(l.level === 'error' ? '오류' : l.level === 'warn' ? '경고' : l.level === 'debug' ? '디버그' : '정보').padEnd(4)}
                </span>{' '}
                <span style={{ color: '#cbd5e1' }}>{l.message}</span>
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
