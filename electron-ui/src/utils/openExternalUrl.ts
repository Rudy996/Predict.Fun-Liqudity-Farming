/** В Electron — системный браузер; в обычном браузере — новая вкладка */
export function openExternalUrl(url: string): void {
  if (typeof window === 'undefined') return
  const api = window.electronAPI
  if (api?.openExternal) {
    void api.openExternal(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}
