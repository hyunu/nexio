import { useState, useEffect, useRef } from 'react';

declare global {
  interface Window {
    electronAPI: {
      serial: {
        list: () => Promise<{ path: string; manufacturer: string }[]>;
        open: (options: { path: string; baudRate: number }) => Promise<{ success: boolean; error?: string }>;
        write: (data: string) => Promise<{ success: boolean; error?: string }>;
        close: () => Promise<{ success: boolean }>;
        onData: (callback: (data: string) => void) => void;
      };
      ws: {
        connect: (url: string) => Promise<{ success: boolean; error?: string }>;
        send: (message: string) => Promise<{ success: boolean; error?: string }>;
        close: () => Promise<{ success: boolean }>;
        isConnected: () => Promise<boolean>;
        onConnected: (callback: () => void) => void;
        onDisconnected: (callback: () => void) => void;
        onMessage: (callback: (message: string) => void) => void;
      };
    };
  }
}

interface LogEntry {
  timestamp: number;
  direction: 'sent' | 'received' | 'error';
  message: string;
}

interface BoardReady {
  boardId: string;
  sessionId: string;
  expiresAt: number;
}

function App() {
  const [serverUrl, setServerUrl] = useState('ws://localhost:10008/ws/client');
  const [wsConnected, setWsConnected] = useState(false);
  const [wsConnecting, setWsConnecting] = useState(false);

  const [serialPorts, setSerialPorts] = useState<{ path: string; manufacturer: string }[]>([]);
  const [selectedPort, setSelectedPort] = useState('');
  const [baudRate, setBaudRate] = useState(115200);
  const [serialConnected, setSerialConnected] = useState(false);
  const [serialConnecting, setSerialConnecting] = useState(false);

  const [boardReady, setBoardReady] = useState<BoardReady | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [displayMode, setDisplayMode] = useState<'text' | 'hex'>('text');

  const logsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadSerialPorts();

    window.electronAPI.ws.onConnected(() => {
      setWsConnected(true);
      setWsConnecting(false);
      addLog('connected', 'WebSocket connected');
    });

    window.electronAPI.ws.onDisconnected(() => {
      setWsConnected(false);
      setBoardReady(null);
      addLog('error', 'WebSocket disconnected');
    });

    window.electronAPI.ws.onMessage((message) => {
      handleWsMessage(message);
    });

    window.electronAPI.serial.onData((data) => {
      const decoded = tryDecodeBase64(data);
      sendToServer(decoded);
      addLog('received', `Serial: ${decoded}`);
    });

    return () => {
      window.electronAPI.ws.close();
      window.electronAPI.serial.close();
    };
  }, []);

  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logs]);

  async function loadSerialPorts() {
    const ports = await window.electronAPI.serial.list();
    setSerialPorts(ports);
    if (ports.length > 0) {
      setSelectedPort(ports[0].path);
    }
  }

  async function connectWs() {
    setWsConnecting(true);
    const result = await window.electronAPI.ws.connect(serverUrl);
    if (!result.success) {
      setWsConnecting(false);
      addLog('error', `Failed to connect: ${result.error}`);
    }
  }

  async function disconnectWs() {
    await window.electronAPI.ws.close();
    setWsConnected(false);
  }

  async function connectSerial() {
    if (!selectedPort) return;

    setSerialConnecting(true);
    const result = await window.electronAPI.serial.open({
      path: selectedPort,
      baudRate: baudRate,
    });

    if (result.success) {
      setSerialConnected(true);
      setSerialConnecting(false);
      addLog('connected', `Serial port ${selectedPort} opened`);

      if (wsConnected) {
        requestBoard();
      }
    } else {
      setSerialConnecting(false);
      addLog('error', `Serial error: ${result.error}`);
    }
  }

  async function disconnectSerial() {
    await window.electronAPI.serial.close();
    setSerialConnected(false);
  }

  async function requestBoard() {
    const message = {
      type: 'REQUEST_BOARD',
      version: '1.0',
      timestamp: Date.now(),
      clientId: `CLIENT-${Date.now()}`,
      sessionDuration: 3600,
    };

    await window.electronAPI.ws.send(JSON.stringify(message));
    addLog('sent', 'Requested board');
  }

  async function sendToServer(data: string) {
    if (!wsConnected || !sessionId) return;

    const base64 = btoa(data);

    const message = {
      type: 'DATA_RELAY',
      version: '1.0',
      timestamp: Date.now(),
      sessionId,
      sourceId: 'CLIENT',
      direction: 'C_TO_B',
      payload: base64,
    };

    await window.electronAPI.ws.send(JSON.stringify(message));
  }

  async function sendFromSerial(data: string) {
    if (!serialConnected) return;

    await window.electronAPI.serial.write(data + '\n');
    addLog('sent', `Serial: ${data}`);
  }

  function handleWsMessage(message: string) {
    try {
      const msg = JSON.parse(message);

      if (msg.type === 'BOARD_READY') {
        setBoardReady({
          boardId: msg.boardId,
          sessionId: msg.sessionId,
          expiresAt: msg.expiresAt,
        });
        setSessionId(msg.sessionId);
        addLog('received', `Board ready: ${msg.boardId}`);
      }

      if (msg.type === 'DATA_RELAY' && msg.direction === 'B_TO_C') {
        const decoded = atob(msg.payload);
        if (serialConnected) {
          window.electronAPI.serial.write(decoded);
        }
        addLog('received', `Server: ${decoded}`);
      }

      if (msg.type === 'ERROR') {
        addLog('error', `Error: ${msg.message}`);
      }
    } catch (err) {
      console.error('Parse error:', err);
    }
  }

  function tryDecodeBase64(data: string): string {
    try {
      return atob(data);
    } catch {
      return data;
    }
  }

  function addLog(direction: 'sent' | 'received' | 'error', message: string) {
    setLogs(prev => [...prev, {
      timestamp: Date.now(),
      direction,
      message,
    }]);
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString();
  }

  return (
    <div className="container">
      <h1>Nexio Client</h1>

      <div className="section">
        <h2>Server Connection</h2>
        <div className="input-group">
          <input
            type="text"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="ws://localhost:10008/ws/client"
            disabled={wsConnected}
          />
          {wsConnected ? (
            <button className="danger" onClick={disconnectWs}>Disconnect</button>
          ) : (
            <button onClick={connectWs} disabled={wsConnecting}>
              {wsConnecting ? 'Connecting...' : 'Connect'}
            </button>
          )}
        </div>
        <span className={`status ${wsConnected ? 'connected' : 'disconnected'}`}>
          {wsConnected ? 'Connected' : 'Disconnected'}
        </span>
      </div>

      <div className="section">
        <h2>Serial Port</h2>
        <div className="input-group">
          <select
            value={selectedPort}
            onChange={(e) => setSelectedPort(e.target.value)}
            disabled={serialConnected}
          >
            <option value="">Select port</option>
            {serialPorts.map(p => (
              <option key={p.path} value={p.path}>
                {p.path} {p.manufacturer ? `(${p.manufacturer})` : ''}
              </option>
            ))}
          </select>
          <select
            value={baudRate}
            onChange={(e) => setBaudRate(Number(e.target.value))}
            disabled={serialConnected}
          >
            <option value={9600}>9600</option>
            <option value={19200}>19200</option>
            <option value={38400}>38400</option>
            <option value={57600}>57600</option>
            <option value={115200}>115200</option>
            <option value={230400}>230400</option>
            <option value={460800}>460800</option>
            <option value={921600}>921600</option>
          </select>
          {serialConnected ? (
            <button className="danger" onClick={disconnectSerial}>Close</button>
          ) : (
            <button onClick={connectSerial} disabled={serialConnecting || !selectedPort}>
              {serialConnecting ? 'Opening...' : 'Open'}
            </button>
          )}
          <button onClick={loadSerialPorts}>Refresh</button>
        </div>
        <span className={`status ${serialConnected ? 'connected' : 'disconnected'}`}>
          {serialConnected ? 'Port Open' : 'Port Closed'}
        </span>
      </div>

      {boardReady && (
        <div className="section">
          <h2>Board Status</h2>
          <div className="board-info">
            <div className="board-info-item">
              <div className="label">Board ID</div>
              <div className="value">{boardReady.boardId}</div>
            </div>
            <div className="board-info-item">
              <div className="label">Session Expires</div>
              <div className="value">{new Date(boardReady.expiresAt).toLocaleString()}</div>
            </div>
          </div>
        </div>
      )}

      <div className="section">
        <h2>Data Log</h2>
        <div className="input-group">
          <button onClick={() => setDisplayMode(displayMode === 'text' ? 'hex' : 'text')}>
            Mode: {displayMode.toUpperCase()}
          </button>
          <button onClick={() => setLogs([])}>Clear</button>
        </div>
        <div className="log-window" ref={logsRef}>
          {logs.map((log, i) => (
            <div key={i} className={`log-entry ${log.direction}`}>
              <span className="timestamp">[{formatTime(log.timestamp)}]</span>
              {log.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default App;
