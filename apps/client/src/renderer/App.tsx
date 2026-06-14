import { useState, useEffect, useRef } from 'react';

declare global {
  interface Window {
    electronAPI: {
      serial: {
        list: () => Promise<{ path: string; manufacturer: string }[]>;
        open: (options: { path: string; baudRate: number }) => Promise<{ success: boolean; error?: string }>;
        write: (data: number[]) => Promise<{ success: boolean; error?: string }>;
        close: () => Promise<{ success: boolean }>;
        onData: (callback: (data: string) => void) => void;
        onDisconnected: (callback: () => void) => void;
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
      log: {
        write: (entry: { ts: number; type: string; msg: string }) => Promise<{ success: boolean }>;
        open: () => Promise<{ success: boolean }>;
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
const MAX_LOG_COUNT = 50000;

const defaultSettings: Settings = {
  serverUrl: 'ws://localhost:10008/ws/client',
  baudRate: 19200,
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
  const authRef = useRef(auth);
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
  const serverStatusRef = useRef(serverStatus);
  const [boardInfo, setBoardInfo] = useState<{ boardId: string; sessionId: string; expiresAt: number; productConnected?: boolean } | null>(null);
  const boardInfoRef = useRef(boardInfo);
  const [boardDisconnectReason, setBoardDisconnectReason] = useState<string | null>(null);
  const [deviceStatus, setDeviceStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const deviceStatusRef = useRef(deviceStatus);

  const [availablePorts, setAvailablePorts] = useState<{ path: string; manufacturer: string }[]>([]);
  const [customPortInput, setCustomPortInput] = useState('');
  const [isCustomPort, setIsCustomPort] = useState(false);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [hexMode, setHexMode] = useState(false);
  const logsRef = useRef<HTMLDivElement>(null);

  const [inputServer, setInputServer] = useState('');
  const [inputDevice, setInputDevice] = useState('');

  const autoConnectRef = useRef(false);
  const boardRequestedRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function startBoardRetry() {
    if (retryTimerRef.current) return;
    retryTimerRef.current = setInterval(() => {
      if (!boardRequestedRef.current && authRef.current) {
        requestBoard();
      }
    }, 2000);
  }

  function stopBoardRetry() {
    if (retryTimerRef.current) {
      clearInterval(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }

  function startReconnectTimer() {
    if (reconnectTimerRef.current) return;
    reconnectTimerRef.current = setInterval(() => {
      window.electronAPI.ws.connect(settings.serverUrl);
    }, 5000);
  }

  function stopReconnectTimer() {
    if (reconnectTimerRef.current) {
      clearInterval(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }

  useEffect(() => { serverStatusRef.current = serverStatus; }, [serverStatus]);
  useEffect(() => { boardInfoRef.current = boardInfo; }, [boardInfo]);
  useEffect(() => { deviceStatusRef.current = deviceStatus; }, [deviceStatus]);
  useEffect(() => { authRef.current = auth; }, [auth]);

  // Auto-retry board request when server is connected but no board assigned
  useEffect(() => {
    if (serverStatus === 'connected' && !boardInfo) {
      // Fire once immediately, then poll every 5s
      if (!boardRequestedRef.current) requestBoard();
      startBoardRetry();
    } else {
      stopBoardRetry();
    }
    return stopBoardRetry;
  }, [serverStatus, boardInfo]);

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
    const entry = { ts: Date.now(), type, msg };
    setLogs(prev => prev.length >= MAX_LOG_COUNT ? [...prev.slice(1), entry] : [...prev, entry]);
    window.electronAPI.log.write(entry);
  }

  function setupListeners() {
    window.electronAPI.ws.onConnected(() => {
      setServerStatus('connected');
      addLog('info', 'Server connected');
      stopReconnectTimer();
      boardRequestedRef.current = false;
      requestBoard();
    });

    window.electronAPI.ws.onDisconnected(() => {
      setServerStatus('disconnected');
      if (boardInfoRef.current) setBoardDisconnectReason('Server disconnected');
      setBoardInfo(null);
      addLog('error', 'Server disconnected');
      startReconnectTimer();
    });

    window.electronAPI.ws.onMessage((message) => {
      handleWsMessage(message);
    });

    window.electronAPI.serial.onDisconnected(() => {
      setDeviceStatus('disconnected');
      addLog('error', 'Serial port disconnected');
    });

    window.electronAPI.serial.onData((data) => {
      let bytes: number[];
      try { bytes = base64ToBytes(data); } catch { bytes = strToBytes(data); }
      const b64 = bytesToBase64(bytes);
      if (serverStatusRef.current === 'connected' && boardInfoRef.current) {
        const msg = { type: 'DATA_RELAY', version: '1.0', timestamp: Date.now(), sessionId: boardInfoRef.current.sessionId, sourceId: 'CLIENT', direction: 'C_TO_B', payload: b64 };
        window.electronAPI.ws.send(JSON.stringify(msg));
      }
      addLog('rx_device', data);
    });

    return () => {
      stopReconnectTimer();
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
    if (!authRef.current || boardRequestedRef.current) return;
    boardRequestedRef.current = true;
    const msg = {
      type: 'REQUEST_BOARD', version: '1.0', timestamp: Date.now(),
      clientId: `CLIENT-${Date.now()}`, sessionDuration: 3600, token: authRef.current.token,
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
    if (settings.serialPortPath && !ports.some(p => p.path === settings.serialPortPath)) {
      setIsCustomPort(true);
      setCustomPortInput(settings.serialPortPath);
    }
    addLog('info', `Found ${ports.length} serial port(s)`);
  }

  async function handleWsMessage(message: string) {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'BOARD_READY') {
        setBoardInfo({ boardId: msg.boardId, sessionId: msg.sessionId, expiresAt: msg.expiresAt, productConnected: msg.productConnected });
        setBoardDisconnectReason(null);
        addLog('info', `Board ready: ${msg.boardId}`);
        if (deviceStatusRef.current === 'connected') {
          const readyMsg = { type: 'CLIENT_READY', sessionId: msg.sessionId, timestamp: Date.now() };
          await window.electronAPI.ws.send(JSON.stringify(readyMsg));
        }
      }
      if (msg.type === 'PRODUCT_STATUS') {
        setBoardInfo(prev => prev ? { ...prev, productConnected: msg.connected } : prev);
        addLog('info', `Product ${msg.connected ? 'connected' : 'disconnected'}`);
      }
      if (msg.type === 'CONTROL' && (msg.action === 'DISCONNECT' || msg.action === 'SESSION_TERMINATED')) {
        setBoardInfo(null);
        setBoardDisconnectReason(msg.reason || 'Session terminated');
        boardRequestedRef.current = false;
        addLog('error', `Session terminated: ${msg.reason || 'unknown'}`);
      }
      if (msg.type === 'END_SESSION') {
        setBoardInfo(null);
        setBoardDisconnectReason(msg.reason || 'Board disconnected');
        boardRequestedRef.current = false;
        addLog('error', `Board disconnected: ${msg.reason || 'unknown'}`);
      }
      if (msg.type === 'AUTH_INFO') {
        addLog('info', `Authenticated as ${authRef.current?.username}`);
      }
      if (msg.type === 'DATA_RELAY' && msg.direction === 'B_TO_C') {
        const bytes = base64ToBytes(msg.payload);
        if (deviceStatusRef.current === 'connected') {
          window.electronAPI.serial.write(bytes);
        }
        const display = msg.hexDisplay || msg.payload;
        addLog('rx_server', display);
      }
      if (msg.type === 'ERROR') {
        addLog('error', `Server: ${msg.message}`);
        if (msg.code === 'BOARD_NOT_FOUND' || msg.code === 'SESSION_EXPIRED') {
          setBoardInfo(null);
          setBoardDisconnectReason(msg.code === 'SESSION_EXPIRED' ? 'Session expired' : null);
          boardRequestedRef.current = false;
          addLog('info', msg.code === 'SESSION_EXPIRED' ? 'Session expired' : 'No idle board available');
        }
      }
    } catch {}
  }

  function strToBytes(s: string): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c > 255) {
        bytes.push((c >> 8) & 0xff);
        bytes.push(c & 0xff);
      } else {
        bytes.push(c);
      }
    }
    return bytes;
  }

  function tryHexEncode(data: string): { ok: boolean; payload: number[] } {
    if (!hexMode) { const b = strToBytes(data); b.push(0x0a); return { ok: true, payload: b }; }
    const hex = data.replace(/\s+/g, '');
    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length === 0) return { ok: false, payload: [] };
    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.substring(i, i + 2), 16));
    bytes.push(0x0a);
    return { ok: true, payload: bytes };
  }

  function bytesToBase64(bytes: number[]): string {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }

  function base64ToBytes(b64: string): number[] {
    const binary = atob(b64);
    const bytes: number[] = [];
    for (let i = 0; i < binary.length; i++) bytes.push(binary.charCodeAt(i));
    return bytes;
  }

  async function sendDataToServer(data: string) {
    if (!data.trim() || serverStatus !== 'connected' || !boardInfo) return;
    const { ok, payload } = tryHexEncode(data);
    if (!ok) { addLog('error', 'HEX: invalid hex string'); return; }
    const base64 = bytesToBase64(payload);
    const msg = { type: 'DATA_RELAY', version: '1.0', timestamp: Date.now(), sessionId: boardInfo.sessionId, sourceId: 'CLIENT', direction: 'C_TO_B', payload: base64 };
    await window.electronAPI.ws.send(JSON.stringify(msg));
    addLog('tx_server', data);
  }

  async function sendDataToDevice(data: string) {
    if (!data.trim() || deviceStatus !== 'connected') return;
    const { ok, payload } = tryHexEncode(data);
    if (!ok) { addLog('error', 'HEX: invalid hex string'); return; }
    await window.electronAPI.serial.write(payload);
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
    stopReconnectTimer();
    stopBoardRetry();
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
            <span className={`pipeline-dot ${boardInfo?.productConnected ? 'on' : 'off'}`} />
            <span className="pipeline-label">DEVICE 1</span>
            {boardInfo && !boardInfo.productConnected && <span className="pipeline-tag reason">Not connected</span>}
            {!boardInfo && <span className="pipeline-tag reason">{boardDisconnectReason || 'Offline'}</span>}
          </div>
          <div className="pipeline-line" />
          <div className="pipeline-node">
            <span className={`pipeline-dot ${boardInfo ? 'on' : 'off'}`} />
            <span className="pipeline-label">MODULE</span>
            {boardInfo && <span className="pipeline-tag">{boardInfo.boardId}</span>}
            {!boardInfo && boardDisconnectReason && <span className="pipeline-tag reason">{boardDisconnectReason}</span>}
            {!boardInfo && !boardDisconnectReason && serverStatus === 'connected' && <span className="pipeline-tag wait">Waiting...</span>}
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
          <select className="port-select" value={
            isCustomPort ? '__custom__' : (availablePorts.some(p => p.path === settings.serialPortPath) ? settings.serialPortPath : '')}
            onChange={e => {
              if (deviceStatus === 'connected') disconnectSerial();
              const v = e.target.value;
              if (v === '__custom__') {
                setIsCustomPort(true);
                setCustomPortInput('');
                const newSettings = { ...settings, serialPortPath: '' };
                setSettings(newSettings);
                localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(newSettings));
              } else {
                setIsCustomPort(false);
                setCustomPortInput('');
                const newSettings = { ...settings, serialPortPath: v };
                setSettings(newSettings);
                localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(newSettings));
              }
            }}>
            <option value="">— Select —</option>
            {availablePorts.map(p => (
              <option key={p.path} value={p.path}>{p.path}{p.manufacturer ? ` (${p.manufacturer})` : ''}</option>
            ))}
            <option value="__custom__">Custom</option>
          </select>
          <input className="port-input" type="text" placeholder="/dev/tty..."
            value={customPortInput}
            onChange={e => {
              if (deviceStatus === 'connected') disconnectSerial();
              setCustomPortInput(e.target.value);
              const newSettings = { ...settings, serialPortPath: e.target.value };
              setSettings(newSettings);
              localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(newSettings));
            }}
            style={{ width: 180, marginLeft: 4, padding: '4px 8px', borderRadius: 4, border: '1px solid #334155', background: '#1e293b', color: '#e2e8f0', fontSize: 12, fontFamily: 'D2Coding, monospace', display: isCustomPort ? 'inline-block' : 'none' }}
          />
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
            <button className="log-toggle" onClick={() => window.electronAPI.log.open()}>OPEN LOG</button>
          </div>
        </div>
      </div>

      {showSettings && settingsModal()}
    </div>
  );
}

export default App;
