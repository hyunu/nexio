import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import log from 'electron-log';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';

let mainWindow: BrowserWindow | null = null;
let serialPort: SerialPort | null = null;
let parser: ReadlineParser | null = null;

const isDev = !app.isPackaged;

log.initialize();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 750,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (serialPort?.isOpen) {
    serialPort.close();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

function httpRequest(url: string, method: string, body?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'https:' ? https : http;
    const options: http.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    };
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function toHttpUrl(wsUrl: string): string {
  return wsUrl
    .replace('wss://', 'https://')
    .replace('ws://', 'http://')
    .replace('/ws/board', '')
    .replace('/ws/client', '');
}

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
    if (serialPort?.isOpen) {
      serialPort.close();
    }

    serialPort = new SerialPort({
      path: portPath,
      baudRate: baudRate || 115200,
    });

    parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));

    parser.on('data', (data: string) => {
      if (mainWindow) {
        mainWindow.webContents.send('serial:data', data.trim());
      }
    });

    return { success: true };
  } catch (err) {
    log.error('Serial open error:', err);
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('serial:write', async (_, data: string) => {
  if (serialPort?.isOpen) {
    serialPort.write(data + '\n');
    return { success: true };
  }
  return { success: false, error: 'Port not open' };
});

ipcMain.handle('serial:close', async () => {
  if (serialPort?.isOpen) {
    serialPort.close();
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle('serial:isOpen', async () => {
  return serialPort?.isOpen || false;
});

ipcMain.handle('server:claim', async (_, { serverUrl, macAddress }: { serverUrl: string; macAddress: string }) => {
  try {
    const httpUrl = toHttpUrl(serverUrl);
    const result = await httpRequest(`${httpUrl}/api/onboarding/claim`, 'POST', JSON.stringify({ macAddress }));
    return JSON.parse(result);
  } catch (err) {
    log.error('Claim error:', err);
    return { error: String(err) };
  }
});

ipcMain.handle('server:checkOnboarding', async (_, { serverUrl, macAddress }: { serverUrl: string; macAddress: string }) => {
  try {
    const httpUrl = toHttpUrl(serverUrl);
    const result = await httpRequest(`${httpUrl}/api/boards/onboarding?mac=${encodeURIComponent(macAddress)}`, 'GET');
    return JSON.parse(result);
  } catch (err) {
    return { registered: false, error: String(err) };
  }
});
