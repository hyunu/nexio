import { app, BrowserWindow, ipcMain, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import log from 'electron-log';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { WebSocket as WSWebSocket } from 'ws';
import { vuartManager } from './vuart/manager';

let mainWindow: BrowserWindow | null = null;
let ws: WSWebSocket | null = null;
let serialPort: SerialPort | null = null;
let parser: ReadlineParser | null = null;
let logFilePath: string = '';

const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

log.initialize();
log.info('Nexio Client starting...');

function initLogFile() {
  const logsDir = path.join(app.getPath('userData'), 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  logFilePath = path.join(logsDir, `session-${ts}.log`);
  fs.writeFileSync(logFilePath, `=== Nexio Client Log ${new Date().toISOString()} ===\n`);
  log.info('Log file:', logFilePath);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => { initLogFile(); createWindow(); });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  await vuartManager.cleanup();
});

ipcMain.handle('serial:list', async () => {
  try {
    const ports = await SerialPort.list();
    const knownPaths = new Set(ports.map(p => p.path));
    const result = ports.map(p => ({ path: p.path, manufacturer: p.manufacturer }));
    const vuarts = vuartManager.list();
    for (const v of vuarts) {
      result.push({ path: v.clientPath, manufacturer: `vUART: ${v.id}` });
    }
    return result;
  } catch (err) {
    log.error('Serial list error:', err);
    return [];
  }
});

ipcMain.handle('serial:open', async (_, { path: portPath, baudRate }) => {
  try {
    if (serialPort && serialPort.isOpen) {
      serialPort.close();
    }

    serialPort = new SerialPort({
      path: portPath,
      baudRate: baudRate || 19200,
      autoOpen: false,
    });

    parser = serialPort.pipe(new ReadlineParser({ delimiter: '\r\n' }));

    parser.on('data', (data: string) => {
      if (mainWindow) {
        mainWindow.webContents.send('serial:data', data);
      }
    });

    serialPort.on('close', () => {
      log.info('Serial port closed');
      if (mainWindow) {
        mainWindow.webContents.send('serial:disconnected');
      }
    });

    serialPort.on('error', (err) => {
      log.error('Serial port error:', err.message);
      if (mainWindow) {
        mainWindow.webContents.send('serial:disconnected');
      }
    });

    await new Promise<void>((resolve, reject) => {
      serialPort!.open((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    return { success: true };
  } catch (err) {
    log.error('Serial open error:', err);
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('serial:write', async (_, data: number[]) => {
  if (serialPort && serialPort.isOpen) {
    serialPort.write(Buffer.from(data));
    return { success: true };
  }
  return { success: false, error: 'Port not open' };
});

ipcMain.handle('serial:close', async () => {
  if (serialPort && serialPort.isOpen) {
    serialPort.close();
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle('vuart:create', async () => {
  try {
    const info = await vuartManager.create();
    return { success: true, data: info };
  } catch (err) {
    log.error('vUART create error:', err);
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('vuart:list', async () => {
  return vuartManager.list();
});

ipcMain.handle('vuart:delete', async (_, id: string) => {
  const ok = await vuartManager.delete(id);
  return { success: ok };
});

ipcMain.handle('ws:connect', async (_, url: string) => {
  try {
    ws = new WSWebSocket(url);

    ws.onopen = () => {
      if (mainWindow) {
        mainWindow.webContents.send('ws:connected');
      }
    };

    ws.onmessage = (event) => {
      if (mainWindow) {
        mainWindow.webContents.send('ws:message', event.data);
      }
    };

    ws.onclose = () => {
      if (mainWindow) {
        mainWindow.webContents.send('ws:disconnected');
      }
    };

    ws.onerror = (error) => {
      log.error('WebSocket error:', error);
    };

    return { success: true };
  } catch (err) {
    log.error('WebSocket connect error:', err);
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('ws:send', async (_, message: string) => {
  if (ws && ws.readyState === WSWebSocket.OPEN) {
    ws.send(message);
    return { success: true };
  }
  return { success: false, error: 'Not connected' };
});

ipcMain.handle('ws:close', async () => {
  if (ws) {
    ws.close();
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle('ws:isConnected', async () => {
  return ws && ws.readyState === WSWebSocket.OPEN;
});

const http = require('http');

function apiPost(hostname: string, port: number, path_: string, body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname,
      port,
      path: `/api${path_}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = http.request(options, (res: any) => {
      let responseBody = '';
      res.on('data', (chunk: any) => (responseBody += chunk));
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode! >= 200 && res.statusCode! < 300, data: JSON.parse(responseBody) });
        } catch {
          resolve({ ok: false, data: { message: responseBody } });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function parseServerUrl(url: string): { hostname: string; port: number } {
  try {
    const u = new URL(url);
    return { hostname: u.hostname, port: parseInt(u.port || '10008', 10) };
  } catch {
    return { hostname: 'localhost', port: 10008 };
  }
}

ipcMain.handle('auth:login', async (_, { username, password, serverUrl }) => {
  try {
    const { hostname, port } = parseServerUrl(serverUrl || 'http://localhost:10008');
    const { ok, data } = await apiPost(hostname, port, '/auth/login', { username, password });
    if (!ok) {
      return { success: false, error: data.message || 'Login failed' };
    }
    log.info('Login success for', username);
    return { success: true, data };
  } catch (err) {
    log.error('auth:login error:', err);
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('auth:register', async (_, { username, password, email, orgName, serverUrl }) => {
  try {
    const { hostname, port } = parseServerUrl(serverUrl || 'http://localhost:10008');
    const { ok, data } = await apiPost(hostname, port, '/auth/register', { username, password, email, orgName });
    if (!ok) {
      return { success: false, error: data.message || 'Registration failed' };
    }
    log.info('Register success for', username);
    return { success: true, data };
  } catch (err) {
    log.error('auth:register error:', err);
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('system:checkSocat', async () => {
  return new Promise((resolve) => {
    cp.exec('which socat', (error, stdout) => {
      resolve({ installed: !error, path: error ? null : stdout.trim() });
    });
  });
});

ipcMain.handle('system:getPlatform', async () => {
  return { platform: process.platform, arch: process.arch };
});

ipcMain.handle('log:open', async () => {
  const dir = path.join(app.getPath('userData'), 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
  return { success: true };
});

ipcMain.handle('log:write', async (_, entry: { ts: number; type: string; msg: string }) => {
  if (!logFilePath) return { success: false };
  try {
    const d = new Date(entry.ts);
    const time = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
    fs.appendFileSync(logFilePath, `[${time}] [${entry.type}] ${entry.msg}\n`);
    return { success: true };
  } catch { return { success: false }; }
});
