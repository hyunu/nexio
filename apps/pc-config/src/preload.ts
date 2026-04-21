import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  serial: {
    list: () => ipcRenderer.invoke('serial:list'),
    open: (options: { path: string; baudRate: number }) =>
      ipcRenderer.invoke('serial:open', options),
    write: (data: string) => ipcRenderer.invoke('serial:write', data),
    close: () => ipcRenderer.invoke('serial:close'),
    isOpen: () => ipcRenderer.invoke('serial:isOpen'),
    onData: (callback: (data: string) => void) => {
      ipcRenderer.on('serial:data', (_, data) => callback(data));
    },
  },
});
