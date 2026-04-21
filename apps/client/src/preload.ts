import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  serial: {
    list: () => ipcRenderer.invoke('serial:list'),
    open: (options: { path: string; baudRate: number }) =>
      ipcRenderer.invoke('serial:open', options),
    write: (data: string) => ipcRenderer.invoke('serial:write', data),
    close: () => ipcRenderer.invoke('serial:close'),
    onData: (callback: (data: string) => void) => {
      ipcRenderer.on('serial:data', (_, data) => callback(data));
    },
  },
  ws: {
    connect: (url: string) => ipcRenderer.invoke('ws:connect', url),
    send: (message: string) => ipcRenderer.invoke('ws:send', message),
    close: () => ipcRenderer.invoke('ws:close'),
    isConnected: () => ipcRenderer.invoke('ws:isConnected'),
    onConnected: (callback: () => void) => {
      ipcRenderer.on('ws:connected', () => callback());
    },
    onDisconnected: (callback: () => void) => {
      ipcRenderer.on('ws:disconnected', () => callback());
    },
    onMessage: (callback: (message: string) => void) => {
      ipcRenderer.on('ws:message', (_, message) => callback(message));
    },
  },
});
