import { useState, useEffect, useRef } from 'react';

const WS_URL = 'ws://localhost:10008/ws/monitor';
const API_BASE = 'http://localhost:10008/api';

interface BoardDetail {
  board: {
    uniqueId: string;
    macAddress: string;
    status: string;
    firmwareVersion: string;
    connectedAt: string;
    updatedAt: string;
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'system-ui' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 20px', background: '#1e293b', color: '#fff' }}>
        <div>
          <strong style={{ fontSize: 18 }}>Board {boardId}</strong>
          {detail && (
            <span style={{ marginLeft: 16, fontSize: 13, color: '#94a3b8' }}>
              MAC: {detail.board.macAddress || '-'} | Status: {detail.board.status}
              {detail.connected && <span style={{ color: '#22c55e', marginLeft: 8 }}>● WS</span>}
              <span style={{ color: connected ? '#22c55e' : '#ef4444', marginLeft: 8 }}>
                {connected ? '● Monitor' : '○ Monitor'}
              </span>
            </span>
          )}
        </div>
        <button onClick={onClose} style={{ padding: '6px 16px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>Close</button>
      </div>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid #e2e8f0' }}>
          <div style={{ padding: '10px 16px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', fontWeight: 600, fontSize: 14, color: '#475569' }}>
            Product Data Exchange
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: 8, background: '#0f172a', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6 }}>
            {dataRelays.length === 0 && <div style={{ color: '#64748b', padding: 8 }}>Waiting for data...</div>}
            {dataRelays.map(d => (
              <div key={d.id} style={{ marginBottom: 4 }}>
                <span style={{ color: '#94a3b8' }}>[{new Date(d.timestamp).toLocaleTimeString()}]</span>{' '}
                <span style={{ color: d.direction === 'B_TO_C' ? '#22d3ee' : '#f472b6', fontWeight: 600 }}>
                  {d.direction === 'B_TO_C' ? '← BOARD' : '→ CLIENT'}
                </span>{' '}
                <span style={{ color: '#e2e8f0' }}>{d.payload?.substring(0, 200)}{(d.payload?.length || 0) > 200 ? '...' : ''}</span>
              </div>
            ))}
            <div ref={dataEndRef} />
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '10px 16px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', fontWeight: 600, fontSize: 14, color: '#475569' }}>
            Log Output
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: 8, background: '#0f172a', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6 }}>
            {logs.length === 0 && <div style={{ color: '#64748b', padding: 8 }}>No logs yet...</div>}
            {logs.map(l => (
              <div key={l.id} style={{ marginBottom: 2 }}>
                <span style={{ color: '#94a3b8' }}>[{new Date(l.timestamp).toLocaleTimeString()}]</span>{' '}
                <span style={{
                  color: l.level === 'error' ? '#ef4444' : l.level === 'warn' ? '#f59e0b' : '#22c55e',
                  fontWeight: 600,
                }}>
                  {l.level.toUpperCase()}
                </span>{' '}
                <span style={{ color: '#e2e8f0' }}>{l.message}</span>
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
