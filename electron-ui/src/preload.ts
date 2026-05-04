import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  getApiUrl: () => ipcRenderer.invoke('get-api-url'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url) as Promise<{ ok: boolean; error?: string }>,
})
