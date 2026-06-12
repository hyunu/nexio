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
      vuart: {
        create: () => Promise<{ success: boolean; data?: { id: string; clientPath: string; devicePath: string; createdAt: number }; error?: string }>;
        list: () => Promise<{ id: string; clientPath: string; devicePath: string; createdAt: number }[]>;
        delete: (id: string) => Promise<{ success: boolean }>;
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
      auth: {
        login: (credentials: { username: string; password: string; serverUrl?: string }) => Promise<{
          success: boolean; error?: string;
          data?: { userId: string; username: string; email: string; orgName: string; token: string };
        }>;
        register: (data: { username: string; password: string; email: string; orgName: string; serverUrl?: string }) => Promise<{
          success: boolean; error?: string;
          data?: { userId: string; username: string; email: string; orgName: string; token: string };
        }>;
      };
      system: {
        checkSocat: () => Promise<{ installed: boolean; path: string | null }>;
        getPlatform: () => Promise<{ platform: string; arch: string }>;
      };
    };
  }
}

type LogType = 'info' | 'tx_server' | 'tx_device' | 'rx_server' | 'rx_device' | 'error';

interface LogEntry {
  ts: number;
  type: LogType;
  msg: string;
}

interface AuthInfo {
  userId: string;
  username: string;
  email: string;
  orgName: string;
  token: string;
}

interface Settings {
  serverUrl: string;
  baudRate: number;
  serialPortPath: string;
  theme: 'dark' | 'light';
}

const LS_AUTH_KEY = 'nexio_auth';
const LS_SETTINGS_KEY = 'nexio_settings';

const defaultSettings: Settings = {
  serverUrl: 'ws://localhost:10008/ws/client',
  baudRate: 115200,
  serialPortPath: '',
  theme: 'dark',
};

function loadAuth(): AuthInfo | null {
  try { const r = localStorage.getItem(LS_AUTH_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
}

function loadSettings(): Settings {
  try { const r = localStorage.getItem(LS_SETTINGS_KEY); return r ? { ...defaultSettings, ...JSON.parse(r) } : defaultSettings; } catch { return defaultSettings; }
}

function formatTime(ts: number) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const zzz = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${zzz}`;
}

function extractHttpUrl(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    return `${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}`;
  } catch {
    return 'http://localhost:10008';
  }
}

function App() {
  const [auth, setAuth] = useState<AuthInfo | null>(loadAuth);
  const [settings, setSettings] = useState<Settings>(() => {
    const s = loadSettings();
    document.body.className = `theme-${s.theme}`;
    return s;
  });
  const [showSettings, setShowSettings] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<Settings>(loadSettings);

  const [authPage, setAuthPage] = useState<'login' | 'register'>('login');
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [regUsername, setRegUsername] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regOrgName, setRegOrgName] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState('');

  const [serverStatus, setServerStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'failed'>('disconnected');
  const [boardInfo, setBoardInfo] = useState<{ boardId: string; sessionId: string; expiresAt: number } | null>(null);
  const [deviceStatus, setDeviceStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');

  const [availablePorts, setAvailablePorts] = useState<{ path: string; manufacturer: string }[]>([]);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [hexMode, setHexMode] = useState(false);
  const logsRef = useRef<HTMLDivElement>(null);

  const [inputServer, setInputServer] = useState('');
  const [inputDevice, setInputDevice] = useState('');

  const autoConnectRef = useRef(false);
  const boardRequestedRef = useRef(false);

  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logs]);

  useEffect(() => {
    document.body.className = `theme-${settings.theme}`;
  }, [settings.theme]);

  useEffect(() => {
    if (!auth) return;
    if (autoConnectRef.current) return;
    autoConnectRef.current = true;

    setupListeners();
    checkEnvironment();
    autoConnectWs();
  }, [auth]);

  function addLog(type: LogType, msg: string) {
    setLogs(prev => [...prev, { ts: Date.now(), type, msg }]);
  }

  function setupListeners() {
    window.electronAPI.ws.onConnected(() => {
      setServerStatus('connected');
      addLog('info', 'Server connected');
      boardRequestedRef.current = false;
      requestBoard();
    });

    window.electronAPI.ws.onDisconnected(() => {
      setServerStatus('disconnected');
      setBoardInfo(null);
      addLog('error', 'Server disconnected');
    });

    window.electronAPI.ws.onMessage((message) => {
      handleWsMessage(message);
    });

    window.electronAPI.serial.onData((data) => {
      let decoded: string;
      try { decoded = atob(data); } catch { decoded = data; }
      sendDataToServer(decoded);
      addLog('rx_device', decoded);
    });

    return () => {
      window.electronAPI.ws.close();
      window.electronAPI.serial.close();
    };
  }

  async function checkEnvironment() {
    scanPorts();
  }

  async function autoConnectWs() {
    setServerStatus('connecting');
    for (let i = 0; i < 3; i++) {
      const result = await window.electronAPI.ws.connect(settings.serverUrl);
      if (result.success) return;
      if (i < 2) await new Promise(r => setTimeout(r, 1000));
    }
    setServerStatus('failed');
    addLog('error', 'Failed to connect after 3 attempts');
  }

  async function reconnectWs() {
    await window.electronAPI.ws.close();
    setServerStatus('connecting');
    autoConnectRef.current = false;
    for (let i = 0; i < 3; i++) {
      const result = await window.electronAPI.ws.connect(settings.serverUrl);
      if (result.success) return;
      if (i < 2) await new Promise(r => setTimeout(r, 1000));
    }
    setServerStatus('failed');
    addLog('error', 'Reconnect failed after 3 attempts');
  }

  async function requestBoard() {
    if (!auth || boardRequestedRef.current) return;
    boardRequestedRef.current = true;
    const msg = {
      type: 'REQUEST_BOARD', version: '1.0', timestamp: Date.now(),
      clientId: `CLIENT-${Date.now()}`, sessionDuration: 3600, token: auth.token,
    };
    await window.electronAPI.ws.send(JSON.stringify(msg));
    addLog('info', 'Requesting board...');
  }

  async function connectSerial() {
    if (!settings.serialPortPath) {
      addLog('error', 'No serial port selected');
      return;
    }
    setDeviceStatus('connecting');
    const result = await window.electronAPI.serial.open({ path: settings.serialPortPath, baudRate: settings.baudRate });
    if (result.success) {
      setDeviceStatus('connected');
      addLog('info', `Connected to ${settings.serialPortPath} @ ${settings.baudRate} baud`);
      if (serverStatus === 'connected' && boardInfo) {
        const msg = { type: 'CLIENT_READY', sessionId: boardInfo.sessionId, timestamp: Date.now() };
        await window.electronAPI.ws.send(JSON.stringify(msg));
      }
    } else {
      setDeviceStatus('disconnected');
      addLog('error', `Connection failed: ${result.error}`);
    }
  }

  async function disconnectSerial() {
    await window.electronAPI.serial.close();
    setDeviceStatus('disconnected');
    addLog('info', 'Serial port disconnected');
  }

  async function scanPorts() {
    const ports = await window.electronAPI.serial.list();
    setAvailablePorts(ports);
    addLog('info', `Found ${ports.length} serial port(s)`);
  }

  async function handleWsMessage(message: string) {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'BOARD_READY') {
        setBoardInfo({ boardId: msg.boardId, sessionId: msg.sessionId, expiresAt: msg.expiresAt });
        addLog('info', `Board ready: ${msg.boardId}`);
        if (deviceStatus === 'connected') {
          const readyMsg = { type: 'CLIENT_READY', sessionId: msg.sessionId, timestamp: Date.now() };
          await window.electronAPI.ws.send(JSON.stringify(readyMsg));
        }
      }
      if (msg.type === 'AUTH_INFO') {
        addLog('info', `Authenticated as ${auth?.username}`);
      }
      if (msg.type === 'DATA_RELAY' && msg.direction === 'B_TO_C') {
        const decoded = atob(msg.payload);
        if (deviceStatus === 'connected') {
          window.electronAPI.serial.write(decoded);
        }
        addLog('rx_server', decoded);
      }
      if (msg.type === 'ERROR') {
        addLog('error', `Server: ${msg.message}`);
        if (msg.code === 'BOARD_NOT_FOUND') {
          addLog('info', 'No idle board available, retrying in 5s...');
          setTimeout(() => { boardRequestedRef.current = false; requestBoard(); }, 5000);
        }
      }
    } catch {}
  }

  function tryHexEncode(data: string): { ok: boolean; payload: string } {
    if (!hexMode) return { ok: true, payload: data };
    const hex = data.replace(/\s+/g, '');
    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length === 0) return { ok: false, payload: data };
    const bytes = [];
    for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.substring(i, i + 2), 16));
    return { ok: true, payload: String.fromCharCode(...bytes) };
  }

  async function sendDataToServer(data: string) {
    if (!data.trim() || serverStatus !== 'connected' || !boardInfo) return;
    const { ok, payload } = tryHexEncode(data);
    if (!ok) { addLog('error', 'HEX: invalid hex string'); return; }
    const base64 = btoa(payload);
    const msg = { type: 'DATA_RELAY', version: '1.0', timestamp: Date.now(), sessionId: boardInfo.sessionId, sourceId: 'CLIENT', direction: 'C_TO_B', payload: base64 };
    await window.electronAPI.ws.send(JSON.stringify(msg));
    addLog('tx_server', data);
  }

  async function sendDataToDevice(data: string) {
    if (!data.trim() || deviceStatus !== 'connected') return;
    const { ok, payload } = tryHexEncode(data);
    if (!ok) { addLog('error', 'HEX: invalid hex string'); return; }
    await window.electronAPI.serial.write(payload + '\n');
    addLog('tx_device', data);
  }

  function saveSettings() {
    localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(settingsDraft));
    setSettings(settingsDraft);
    setShowSettings(false);
    addLog('info', 'Settings saved');
    reconnectWs();
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!loginUsername || !loginPassword) return;
    setAuthLoading(true); setAuthError('');
    const serverUrl = extractHttpUrl(settings.serverUrl);
    const result = await window.electronAPI.auth.login({ username: loginUsername, password: loginPassword, serverUrl });
    setAuthLoading(false);
    if (result.success && result.data) {
      localStorage.setItem(LS_AUTH_KEY, JSON.stringify(result.data));
      setAuth(result.data);
    } else {
      setAuthError(result.error || 'Login failed');
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!regUsername || !regPassword) return;
    setAuthLoading(true); setAuthError('');
    const serverUrl = extractHttpUrl(settings.serverUrl);
    const result = await window.electronAPI.auth.register({ username: regUsername, password: regPassword, email: regEmail, orgName: regOrgName, serverUrl });
    setAuthLoading(false);
    if (result.success && result.data) {
      localStorage.setItem(LS_AUTH_KEY, JSON.stringify(result.data));
      setAuth(result.data);
    } else {
      setAuthError(result.error || 'Registration failed');
    }
  }

  function handleLogout() {
    localStorage.removeItem(LS_AUTH_KEY);
    window.electronAPI.ws.close(); window.electronAPI.serial.close();
    setAuth(null); setServerStatus('disconnected'); setBoardInfo(null); setDeviceStatus('disconnected');
    autoConnectRef.current = false;
  }

  function settingsModal() {
    return (
      <div className="modal-overlay" onClick={() => setShowSettings(false)}>
        <div className="modal" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <span>Settings</span>
            <button className="icon-btn" onClick={() => setShowSettings(false)}>✕</button>
          </div>
          <div className="modal-body">
            <div className="settings-field">
              <label>Server URL</label>
              <input type="text" value={settingsDraft.serverUrl} onChange={e => setSettingsDraft({ ...settingsDraft, serverUrl: e.target.value })} />
            </div>
            <div className="settings-field">
              <label>Theme</label>
              <select value={settingsDraft.theme} onChange={e => setSettingsDraft({ ...settingsDraft, theme: e.target.value as 'dark' | 'light' })}>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </div>
          </div>
          <div className="modal-footer">
            <button className="modal-btn" onClick={() => setShowSettings(false)}>Cancel</button>
            <button className="modal-btn primary" onClick={saveSettings}>Save & Reconnect</button>
          </div>
        </div>
      </div>
    );
  }

  function logContent(entry: LogEntry): string {
    const prefix = { 'info': '●', 'tx_server': '→ SV', 'tx_device': '→ DV', 'rx_server': '← SV', 'rx_device': '← DV', 'error': '✕' }[entry.type];
    return `${prefix} ${entry.msg}`;
  }

  if (!auth) {
    return (
      <div className={`auth-container theme-${settings.theme}`}>
        <div style={{position:'fixed',top:12,right:16,zIndex:200}}>
          <button className="icon-btn" onClick={() => { setSettingsDraft({ ...settings }); setShowSettings(true); scanPorts(); }} title="Settings"><span className="settings-icon">⛭</span></button>
        </div>
        <div className="auth-card">
          <div className="auth-header">
            <div className="logo">N</div>
            <h1>Nexio Client</h1>
          </div>
          <div className="auth-tabs">
            <button className={`auth-tab ${authPage === 'login' ? 'active' : ''}`} onClick={() => { setAuthPage('login'); setAuthError(''); }}>Sign In</button>
            <button className={`auth-tab ${authPage === 'register' ? 'active' : ''}`} onClick={() => { setAuthPage('register'); setAuthError(''); }}>Register</button>
          </div>
          {authError && <div className="auth-error">{authError}</div>}
          {authPage === 'login' ? (
            <form onSubmit={handleLogin} className="auth-form">
              <div className="auth-field"><label>Username</label><input type="text" placeholder="Username" value={loginUsername} onChange={e => setLoginUsername(e.target.value)} disabled={authLoading} /></div>
              <div className="auth-field"><label>Password</label><input type="password" placeholder="Password" value={loginPassword} onChange={e => setLoginPassword(e.target.value)} disabled={authLoading} /></div>
              <button type="submit" className="auth-btn" disabled={authLoading || !loginUsername || !loginPassword}>{authLoading ? 'Signing in...' : 'Sign In'}</button>
            </form>
          ) : (
            <form onSubmit={handleRegister} className="auth-form">
              <div className="auth-field"><label>Username</label><input type="text" placeholder="Choose username" value={regUsername} onChange={e => setRegUsername(e.target.value)} disabled={authLoading} /></div>
              <div className="auth-field"><label>Password</label><input type="password" placeholder="Choose password" value={regPassword} onChange={e => setRegPassword(e.target.value)} disabled={authLoading} /></div>
              <div className="auth-field"><label>Email</label><input type="email" placeholder="email@example.com" value={regEmail} onChange={e => setRegEmail(e.target.value)} disabled={authLoading} /></div>
              <div className="auth-field"><label>Organization</label><input type="text" placeholder="Optional" value={regOrgName} onChange={e => setRegOrgName(e.target.value)} disabled={authLoading} /></div>
              <button type="submit" className="auth-btn" disabled={authLoading || !regUsername || !regPassword}>{authLoading ? 'Registering...' : 'Create Account'}</button>
            </form>
          )}
        </div>
        {showSettings && settingsModal()}
      </div>
    );
  }

  return (
    <div className={`app theme-${settings.theme}`}>
      <div className="topbar">
        <div className="topbar-left">
          <span className="topbar-logo">N</span>
          <span className="topbar-title">Nexio Client</span>
        </div>
      <div className="topbar-right">
        <span className="topbar-user">{auth.username}{auth.orgName ? ` @ ${auth.orgName}` : ''}</span>
        <button className="icon-btn" onClick={() => { setSettingsDraft({ ...settings }); setShowSettings(true); scanPorts(); }} title="Settings"><span className="settings-icon">⛭</span></button>
        <button className="icon-btn logout" onClick={handleLogout} title="Sign out">✕</button>
      </div>
      </div>
      <div className="divider" />
      <div className="section-title">PIPELINE</div>
      <div className="pipeline-section">
        <div className="pipeline">
          <div className="pipeline-end">
            <span className={`pipeline-dot ${boardInfo ? 'on' : ''}`} />
            <span className="pipeline-label">DEVICE 1</span>
          </div>
          <div className="pipeline-line" />
          <div className="pipeline-node">
            <span className={`pipeline-dot ${boardInfo ? 'on' : ''}`} />
            <span className="pipeline-label">MODULE</span>
            {boardInfo && <span className="pipeline-tag">{boardInfo.boardId}</span>}
            {!boardInfo && serverStatus === 'connected' && <span className="pipeline-tag wait">Waiting...</span>}
          </div>
          <div className="pipeline-line" />
          <div className="pipeline-node">
            <span className={`pipeline-dot ${serverStatus === 'connected' ? 'on' : ''}`} />
            <span className="pipeline-label">SERVER</span>
            {serverStatus === 'failed' && <button className="retry-btn" onClick={reconnectWs} style={{fontSize:9,padding:'1px 6px',marginLeft:4}}>Retry</button>}
          </div>
          <div className="pipeline-line" />
          <div className="pipeline-node">
            <span className="pipeline-dot on" />
            <span className="pipeline-label">CLIENT</span>
          </div>
          <div className="pipeline-line" />
          <div className="pipeline-end">
            <span className={`pipeline-dot ${deviceStatus === 'connected' ? 'on' : ''}`} />
            <span className="pipeline-label">DEVICE 2</span>
            {deviceStatus === 'connected' && <span className="pipeline-tag">{settings.serialPortPath}</span>}
          </div>
        </div>
      </div>
      <div className="divider" />
      <div className="section-title">DEVICE 2</div>
      <div className="port-section">
        <div className="port-row">
          <span className="port-label" style={{marginLeft:0}}>Serial Port</span>
          <select className="port-select" value={settings.serialPortPath}
            onChange={e => {
              if (deviceStatus === 'connected') disconnectSerial();
              const newSettings = { ...settings, serialPortPath: e.target.value };
              setSettings(newSettings);
              localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(newSettings));
            }}>
            <option value="">— Select —</option>
            {availablePorts.filter(p => !p.manufacturer?.startsWith('vUART:')).map(p => (
              <option key={p.path} value={p.path}>{p.path}{p.manufacturer ? ` (${p.manufacturer})` : ''}</option>
            ))}
          </select>
          <button className="scan-btn" onClick={scanPorts}>Scan</button>
          <span className="port-label" style={{marginLeft:8}}>Baudrate</span>
          <select className="port-select baud" value={settings.baudRate} onChange={e => {
            const newSettings = { ...settings, baudRate: Number(e.target.value) };
            setSettings(newSettings);
            localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(newSettings));
          }}>
            {[9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map(b => <option key={b} value={b}>{b}</option>)}
          </select>
          <button className={`connect-btn ${deviceStatus === 'connected' ? 'disconnect' : ''}`}
            onClick={deviceStatus === 'connected' ? disconnectSerial : connectSerial}
            disabled={!settings.serialPortPath || deviceStatus === 'connecting'}>
            {deviceStatus === 'connected' ? 'Disconnect' : deviceStatus === 'connecting' ? 'Opening...' : 'Connect'}
          </button>
        </div>
      </div>
      <div className="divider" />
      <div className="section-title">SEND</div>
      <div className="input-section">
        <div className="input-row">
          <span className="input-label sv">SERVER</span>
          <input type="text" placeholder="Send to Server..." value={inputServer} onChange={e => setInputServer(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { sendDataToServer(inputServer); setInputServer(''); } }} />
          <button className={`send-toggle ${hexMode ? 'active' : ''}`} onClick={() => setHexMode(!hexMode)} title="Toggle HEX mode">HEX</button>
          <button className="send-btn" onClick={() => { sendDataToServer(inputServer); setInputServer(''); }} disabled={serverStatus !== 'connected' || !boardInfo}>SEND</button>
        </div>
        <div className="input-row">
          <span className="input-label dv">DEVICE 2</span>
          <input type="text" placeholder="Send to Device..." value={inputDevice} onChange={e => setInputDevice(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { sendDataToDevice(inputDevice); setInputDevice(''); } }} />
          <button className={`send-toggle ${hexMode ? 'active' : ''}`} onClick={() => setHexMode(!hexMode)} title="Toggle HEX mode">HEX</button>
          <button className="send-btn" onClick={() => { sendDataToDevice(inputDevice); setInputDevice(''); }} disabled={deviceStatus !== 'connected'}>SEND</button>
        </div>
      </div>
      <div className="divider" />
      <div className="section-title">LOG</div>
      <div className="log-section">
        <div className="log-panel" ref={logsRef}>
          {logs.map((entry, i) => (
            <div key={i} className={`log-line ${entry.type}`}>
              <span className="log-time">[{formatTime(entry.ts)}]</span>
              <span className="log-msg">{logContent(entry)}</span>
            </div>
          ))}
        </div>
        <div className="log-footer">
          <div className="log-actions">
            <button className="log-toggle" onClick={() => setLogs([])}>CLEAR</button>
          </div>
        </div>
      </div>

      {showSettings && settingsModal()}
    </div>
  );
}

export default App;
