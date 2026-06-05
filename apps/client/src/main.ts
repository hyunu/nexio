import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import log from 'electron-log';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';

let mainWindow: BrowserWindow | null = null;
let ws: WebSocket | null = null;
let serialPort: SerialPort | null = null;
let parser: ReadlineParser | null = null;

const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

log.initialize();
log.info('Nexio Client starting...');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('serial:list', async () => {
  try {
    const ports = await SerialPort.list();
    return ports.map(p => ({ path: p.path, manufacturer: p.manufacturer }));
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
      baudRate: baudRate || 115200,
    });

    parser = serialPort.pipe(new ReadlineParser({ delimiter: '\r\n' }));

    parser.on('data', (data: string) => {
      if (mainWindow) {
        mainWindow.webContents.send('serial:data', data);
      }
    });

    return { success: true };
  } catch (err) {
    log.error('Serial open error:', err);
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('serial:write', async (_, data: string) => {
  if (serialPort && serialPort.isOpen) {
    serialPort.write(data);
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

ipcMain.handle('ws:connect', async (_, url: string) => {
  try {
    ws = new WebSocket(url);

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
  if (ws && ws.readyState === WebSocket.OPEN) {
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
  return ws && ws.readyState === WebSocket.OPEN;
});

const API_BASE = 'http://localhost:10008/api';

const http = require('http');

function apiPost(path: string, body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'localhost',
      port: 10008,
      path: `/api${path}`,
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

ipcMain.handle('auth:login', async (_, { username, password }) => {
  try {
    const { ok, data } = await apiPost('/auth/login', { username, password });
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

ipcMain.handle('auth:register', async (_, { username, password, email, orgName }) => {
  try {
    const { ok, data } = await apiPost('/auth/register', { username, password, email, orgName });
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
