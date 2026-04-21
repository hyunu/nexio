import { useState, useEffect } from 'react';

declare global {
  interface Window {
    electronAPI: {
      serial: {
        list: () => Promise<{ path: string; manufacturer: string }[]>;
        open: (options: { path: string; baudRate: number }) => Promise<{ success: boolean; error?: string }>;
        write: (data: string) => Promise<{ success: boolean; error?: string }>;
        close: () => Promise<{ success: boolean }>;
        isOpen: () => Promise<boolean>;
        onData: (callback: (data: string) => void) => void;
      };
    };
  }
}

interface LogEntry {
  id: number;
  type: 'sent' | 'received' | 'info' | 'error';
  message: string;
  timestamp: Date;
}

function App() {
  const [ports, setPorts] = useState<{ path: string; manufacturer: string }[]>([]);
  const [selectedPort, setSelectedPort] = useState('');
  const [baudRate, setBaudRate] = useState(115200);
  const [serialConnected, setSerialConnected] = useState(false);

  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [serverUrl, setServerUrl] = useState('ws://192.168.1.100:10008/ws/board');

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    loadPorts();
    window.electronAPI.serial.onData(handleData);
  }, []);

  async function loadPorts() {
    const portList = await window.electronAPI.serial.list();
    setPorts(portList);
    if (portList.length > 0 && !selectedPort) {
      setSelectedPort(portList[0].path);
    }
  }

  async function connectSerial() {
    if (!selectedPort) return;

    const result = await window.electronAPI.serial.open({
      path: selectedPort,
      baudRate,
    });

    if (result.success) {
      setSerialConnected(true);
      addLog('info', `Connected to ${selectedPort}`);
    } else {
      addLog('error', `Error: ${result.error}`);
    }
  }

  async function disconnectSerial() {
    await window.electronAPI.serial.close();
    setSerialConnected(false);
    addLog('info', 'Disconnected');
  }

  async function sendConfig() {
    if (!serialConnected || !ssid || !password || !serverUrl) return;

    setSending(true);
    addLog('info', 'Sending configuration...');

    const config = JSON.stringify({
      ssid,
      password,
      serverUrl,
    });

    const result = await window.electronAPI.serial.write(config);

    if (result.success) {
      addLog('sent', config);
      addLog('info', 'Configuration sent! ESP32 will restart with new settings.');
    } else {
      addLog('error', `Failed: ${result.error}`);
    }

    setSending(false);
  }

  async function sendRawCommand() {
    if (!serialConnected) return;
    const cmd = JSON.stringify({ raw: true });
    await window.electronAPI.serial.write(cmd);
    addLog('sent', cmd);
  }

  function handleData(data: string) {
    addLog('received', data);
  }

  function addLog(type: LogEntry['type'], message: string) {
    setLogs(prev => [...prev, {
      id: Date.now(),
      type,
      message,
      timestamp: new Date(),
    }]);
  }

  function formatTime(date: Date): string {
    return date.toLocaleTimeString();
  }

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Nexio PC Config</h1>
      <p style={styles.subtitle}>ESP32 WiFi Configuration via Serial</p>

      <div style={styles.section}>
        <h2>Serial Connection</h2>
        <div style={styles.row}>
          <select
            value={selectedPort}
            onChange={e => setSelectedPort(e.target.value)}
            disabled={serialConnected}
            style={styles.select}
          >
            <option value="">Select Port</option>
            {ports.map(p => (
              <option key={p.path} value={p.path}>
                {p.path} {p.manufacturer ? `(${p.manufacturer})` : ''}
              </option>
            ))}
          </select>
          <select
            value={baudRate}
            onChange={e => setBaudRate(Number(e.target.value))}
            disabled={serialConnected}
            style={styles.select}
          >
            <option value={9600}>9600</option>
            <option value={19200}>19200</option>
            <option value={38400}>38400</option>
            <option value={57600}>57600</option>
            <option value={115200}>115200</option>
            <option value={230400}>230400</option>
          </select>
          {serialConnected ? (
            <button onClick={disconnectSerial} style={styles.dangerBtn}>Disconnect</button>
          ) : (
            <button onClick={connectSerial} disabled={!selectedPort}>Connect</button>
          )}
          <button onClick={loadPorts}>Refresh</button>
        </div>
        <div style={styles.status}>
          <span style={{
            ...styles.statusDot,
            background: serialConnected ? '#22c55e' : '#ef4444',
          }} />
          {serialConnected ? 'Connected' : 'Disconnected'}
        </div>
      </div>

      <div style={styles.section}>
        <h2>WiFi Configuration</h2>
        <div style={styles.form}>
          <label style={styles.label}>WiFi SSID</label>
          <input
            type="text"
            value={ssid}
            onChange={e => setSsid(e.target.value)}
            placeholder="Your WiFi network name"
            style={styles.input}
          />

          <label style={styles.label}>WiFi Password</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Your WiFi password"
            style={styles.input}
          />

          <label style={styles.label}>Server URL</label>
          <input
            type="text"
            value={serverUrl}
            onChange={e => setServerUrl(e.target.value)}
            placeholder="ws://192.168.1.100:10008/ws/board"
            style={styles.input}
          />

          <button
            onClick={sendConfig}
            disabled={sending || !serialConnected || !ssid || !password}
            style={styles.sendBtn}
          >
            {sending ? 'Sending...' : 'Send Configuration'}
          </button>
        </div>
      </div>

      <div style={styles.section}>
        <h2>Log</h2>
        <div style={styles.logWindow}>
          {logs.map(log => (
            <div key={log.id} style={{
              ...styles.logEntry,
              color: log.type === 'error' ? '#ef4444' :
                     log.type === 'sent' ? '#22c55e' :
                     log.type === 'received' ? '#3b82f6' : '#888',
            }}>
              [{formatTime(log.timestamp)}] {log.message}
            </div>
          ))}
          {logs.length === 0 && <div style={styles.logEntry}>No logs yet...</div>}
        </div>
        <button onClick={() => setLogs([])} style={styles.clearBtn}>Clear</button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 500,
    margin: '0 auto',
    padding: 20,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    background: '#1a1a1a',
    minHeight: '100vh',
    color: '#fff',
  },
  title: {
    marginBottom: 4,
  },
  subtitle: {
    color: '#888',
    marginBottom: 20,
  },
  section: {
    background: '#2a2a2a',
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
  },
  row: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
  },
  select: {
    flex: 1,
    minWidth: 120,
    padding: '8px 12px',
    border: '1px solid #444',
    borderRadius: 4,
    background: '#1a1a1a',
    color: '#fff',
  },
  status: {
    marginTop: 8,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: '#888',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  label: {
    fontSize: 14,
    color: '#888',
  },
  input: {
    padding: '10px 12px',
    border: '1px solid #444',
    borderRadius: 4,
    background: '#1a1a1a',
    color: '#fff',
    fontSize: 14,
  },
  sendBtn: {
    marginTop: 12,
    padding: '12px',
    background: '#3b82f6',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 500,
  },
  logWindow: {
    background: '#0a0a0a',
    borderRadius: 4,
    padding: 12,
    height: 150,
    overflowY: 'auto',
    fontFamily: 'monospace',
    fontSize: 12,
  },
  logEntry: {
    marginBottom: 4,
  },
  clearBtn: {
    marginTop: 8,
    padding: '4px 12px',
    background: '#444',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
  },
};

export default App;