import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
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
    height: 700,
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
