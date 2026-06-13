import { useState, useEffect, useRef, useCallback } from 'react';

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
      server: {
        claim: (options: { serverUrl: string; macAddress: string }) => Promise<Record<string, unknown>>;
        checkOnboarding: (options: { serverUrl: string; macAddress: string }) => Promise<Record<string, unknown>>;
      };
    };
  }
}

type OnboardingStage = 'form' | 'claiming' | 'sending' | 'waiting' | 'completed' | 'failed';

interface LogEntry {
  id: number;
  type: 'sent' | 'received' | 'info' | 'error';
  message: string;
  timestamp: Date;
}

const STORAGE_KEY_SERVER_URL = 'nexio_server_url';

function App() {
  const [ports, setPorts] = useState<{ path: string; manufacturer: string }[]>([]);
  const [selectedPort, setSelectedPort] = useState('');
  const [baudRate, setBaudRate] = useState(19200);
  const [serialConnected, setSerialConnected] = useState(false);

  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [serverUrl, setServerUrl] = useState('ws://192.168.1.100:10008/ws/board');
  const [macAddress, setMacAddress] = useState('');
  const [productBaudRate, setProductBaudRate] = useState(19200);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [onboardingStage, setOnboardingStage] = useState<OnboardingStage>('form');
  const [statusMessage, setStatusMessage] = useState('');
  const [boardUniqueId, setBoardUniqueId] = useState('');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY_SERVER_URL);
    if (saved) setServerUrl(saved);
    loadPorts();
    window.electronAPI.serial.onData(handleData);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
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
    const result = await window.electronAPI.serial.open({ path: selectedPort, baudRate });
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

  async function startOnboarding() {
    if (!serialConnected || !ssid || !password || !serverUrl) return;

    localStorage.setItem(STORAGE_KEY_SERVER_URL, serverUrl);

    const mac = macAddress.trim() || 'unknown';
    setOnboardingStage('claiming');
    setStatusMessage('Claiming board ID from server...');
    addLog('info', `Claiming board ID from server (MAC: ${mac})...`);

    const claimResult = await window.electronAPI.server.claim({ serverUrl, macAddress: mac });
    const uniqueId = claimResult.uniqueId as string | undefined;
    if (!uniqueId) {
      setOnboardingStage('failed');
      setStatusMessage(`Failed to claim board ID: ${(claimResult.error as string) || 'unknown error'}`);
      addLog('error', `Claim failed: ${JSON.stringify(claimResult)}`);
      return;
    }

    setBoardUniqueId(uniqueId);
    setStatusMessage(`Board ID: ${uniqueId}\nSending configuration...`);
    addLog('info', `Claimed board ID: ${uniqueId}`);

    setOnboardingStage('sending');
    const config = JSON.stringify({ ssid, password, serverUrl, uniqueId, baudRate: productBaudRate });
    const writeResult = await window.electronAPI.serial.write(config);

    if (!writeResult.success) {
      setOnboardingStage('failed');
      setStatusMessage(`Serial write failed: ${writeResult.error}`);
      addLog('error', `Write failed: ${writeResult.error}`);
      return;
    }

    addLog('sent', config);
    addLog('info', `Configuration sent!\nWaiting for board ${uniqueId} to connect to server...`);

    setOnboardingStage('waiting');
    setStatusMessage(`Configuration sent!\nWaiting for board ${uniqueId}\nto connect to server...`);

    startPolling(mac, uniqueId);
  }

  function startPolling(mac: string, uniqueId: string) {
    const deadline = Date.now() + 30000;
    if (pollRef.current) clearInterval(pollRef.current);

    pollRef.current = setInterval(async () => {
      if (Date.now() > deadline) {
        if (pollRef.current) clearInterval(pollRef.current);
        setOnboardingStage('failed');
        setStatusMessage(`Board ${uniqueId} did not connect within 30 seconds.\nCheck WiFi credentials and try again.`);
        addLog('error', 'Onboarding timeout (30s)');
        return;
      }

      const result = await window.electronAPI.server.checkOnboarding({ serverUrl, macAddress: mac });
      if (result.registered === true) {
        if (pollRef.current) clearInterval(pollRef.current);
        setOnboardingStage('completed');
        setStatusMessage(`Onboarding complete!\nBoard ${uniqueId} is ready`);
        addLog('info', `Board ${uniqueId} registered with server`);
      }
    }, 3000);
  }

  function resetOnboarding() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setOnboardingStage('form');
    setStatusMessage('');
    setBoardUniqueId('');
  }

  function handleData(data: string) {
    addLog('received', data);
  }

  const addLog = useCallback((type: LogEntry['type'], message: string) => {
    setLogs(prev => [...prev, { id: Date.now(), type, message, timestamp: new Date() }]);
  }, []);

  function formatTime(date: Date): string {
    return date.toLocaleTimeString();
  }

  const isWorking = onboardingStage !== 'form' && onboardingStage !== 'completed' && onboardingStage !== 'failed';

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
            disabled={serialConnected || isWorking}
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
            disabled={serialConnected || isWorking}
            style={styles.select}
          >
            {[9600, 19200, 38400, 57600, 115200, 230400].map(b => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
          {serialConnected ? (
            <button onClick={disconnectSerial} disabled={isWorking} style={styles.dangerBtn}>Disconnect</button>
          ) : (
            <button onClick={connectSerial} disabled={!selectedPort}>Connect</button>
          )}
          <button onClick={loadPorts} disabled={isWorking}>Refresh</button>
        </div>
        <div style={styles.status}>
          <span style={{ ...styles.statusDot, background: serialConnected ? '#22c55e' : '#ef4444' }} />
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
            disabled={isWorking}
            style={styles.input}
          />

          <label style={styles.label}>WiFi Password</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Your WiFi password"
            disabled={isWorking}
            style={styles.input}
          />

          <label style={styles.label}>Server URL</label>
          <input
            type="text"
            value={serverUrl}
            onChange={e => setServerUrl(e.target.value)}
            placeholder="ws://192.168.1.100:10008/ws/board"
            disabled={isWorking}
            style={styles.input}
          />

          <label style={styles.label}>MAC Address (optional)</label>
          <input
            type="text"
            value={macAddress}
            onChange={e => setMacAddress(e.target.value.toUpperCase())}
            placeholder="e.g. 24:62:AB:F1:90:01"
            disabled={isWorking}
            style={styles.input}
          />

          <label style={styles.label}>Product UART Baud Rate</label>
          <select
            value={productBaudRate}
            onChange={e => setProductBaudRate(Number(e.target.value))}
            disabled={isWorking}
            style={styles.select}
          >
            {[9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map(b => (
              <option key={b} value={b}>{b} bps</option>
            ))}
          </select>

          {onboardingStage === 'form' && (
            <button
              onClick={startOnboarding}
              disabled={!serialConnected || !ssid || !password}
              style={styles.sendBtn}
            >
              Send Configuration
            </button>
          )}

          {(onboardingStage === 'completed' || onboardingStage === 'failed') && (
            <button onClick={resetOnboarding} style={onboardingStage === 'completed' ? styles.successBtn : styles.dangerBtn}>
              {onboardingStage === 'completed' ? 'Configure Another Device' : 'Retry'}
            </button>
          )}
        </div>
      </div>

      {(onboardingStage === 'claiming' || onboardingStage === 'sending' || onboardingStage === 'waiting') && (
        <div style={styles.statusBanner(undefined)}>
          <div style={styles.statusRow}>
            {(onboardingStage === 'claiming' || onboardingStage === 'waiting') && <span style={styles.spinner} />}
            <span>{statusMessage}</span>
          </div>
          {boardUniqueId && onboardingStage === 'waiting' && (
            <div style={styles.progressBar}>
              <div style={styles.progressFill} />
            </div>
          )}
        </div>
      )}

      {onboardingStage === 'completed' && (
        <div style={styles.statusBanner('completed')}>
          <div style={styles.statusRow}>
            <span style={styles.iconGreen}>&#10003;</span>
            <span>{statusMessage}</span>
          </div>
        </div>
      )}

      {onboardingStage === 'failed' && (
        <div style={styles.statusBanner('failed')}>
          <div style={styles.statusRow}>
            <span style={styles.iconRed}>&#10007;</span>
            <span>{statusMessage}</span>
          </div>
        </div>
      )}

      <div style={styles.section}>
        <div style={styles.logHeader}>
          <h2>Log</h2>
          <button onClick={() => setLogs([])} style={styles.clearBtn}>Clear</button>
        </div>
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
      </div>
    </div>
  );
}

const styles: Record<string, any> = {
  container: {
    maxWidth: 500,
    margin: '0 auto',
    padding: 20,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    background: '#1a1a1a',
    minHeight: '100vh',
    color: '#fff',
  },
  title: { marginBottom: 4 },
  subtitle: { color: '#888', marginBottom: 20 },
  section: {
    background: '#2a2a2a',
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
  },
  row: { display: 'flex', gap: 8, flexWrap: 'wrap' },
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
  statusDot: { width: 8, height: 8, borderRadius: '50%' },
  form: { display: 'flex', flexDirection: 'column', gap: 8 },
  label: { fontSize: 14, color: '#888' },
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
  successBtn: {
    marginTop: 12,
    padding: '12px',
    background: '#22c55e',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 500,
  },
  dangerBtn: {
    padding: '8px 16px',
    background: '#ef4444',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 14,
  },
  statusBanner: (type?: string) => ({
    background: type === 'completed' ? '#064e3b' : type === 'failed' ? '#450a0a' : '#1e3a5f',
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
  }),
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    fontSize: 14,
    whiteSpace: 'pre-line' as const,
  },
  spinner: {
    width: 16,
    height: 16,
    border: '2px solid #60a5fa',
    borderTopColor: 'transparent',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },
  iconGreen: { color: '#22c55e', fontSize: 20, fontWeight: 'bold' },
  iconRed: { color: '#ef4444', fontSize: 20, fontWeight: 'bold' },
  progressBar: {
    marginTop: 8,
    height: 4,
    background: '#444',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    width: '30%',
    background: '#60a5fa',
    borderRadius: 2,
    animation: 'slide 2s ease-in-out infinite',
  },
  logHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
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
  logEntry: { marginBottom: 4 },
  clearBtn: {
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