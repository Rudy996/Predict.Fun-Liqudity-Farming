/// <reference types="vite/client" />

interface ElectronAPI {
  getApiUrl: () => Promise<string>
  openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>
}

interface Window {
  electronAPI?: ElectronAPI
}
