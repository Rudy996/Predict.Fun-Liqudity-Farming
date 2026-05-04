import { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { api } from '../api'
import type { GlobalConfig } from '../types'

interface GlobalSettingsDialogProps { onClose: () => void }

export default function GlobalSettingsDialog({ onClose }: GlobalSettingsDialogProps) {
  const [config, setConfig] = useState<GlobalConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [tgTestLoading, setTgTestLoading] = useState(false)
  const [tgTestMode, setTgTestMode] = useState<'summary' | 'balance'>('summary')
  const [tgTestFeedback, setTgTestFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  useEffect(() => { api.getConfig().then(setConfig) }, [])
  const handleSave = async () => { if (!config) return; setLoading(true); try { await api.updateConfig(config) } finally { setLoading(false) } }
  const handleTelegramTest = async () => {
    if (!config) return
    setTgTestLoading(true)
    setTgTestFeedback(null)
    try {
      const r = await api.telegramSendTest({
        mode: tgTestMode,
        telegram_token: config.telegram_token,
        telegram_chat_id: config.telegram_chat_id,
      })
      if (r.success) setTgTestFeedback({ kind: 'ok', text: 'Тестовое сообщение отправлено' })
      else setTgTestFeedback({ kind: 'err', text: r.error || 'Не удалось отправить' })
    } catch {
      setTgTestFeedback({ kind: 'err', text: 'Ошибка запроса' })
    } finally {
      setTgTestLoading(false)
    }
  }
  const update = (key: string, value: any) => setConfig(prev => prev ? { ...prev, [key]: value } : prev)
  if (!config) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fadeIn" onClick={onClose}>
      <div className="w-full max-w-lg bg-dark-800 border border-dark-600 rounded-xl animate-slideDown max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-dark-600">
          <h2 className="text-lg font-semibold">Global Settings</h2>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-200 transition-colors"><X size={18} /></button>
        </div>
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm text-gray-400 mb-1">WebSocket Pool Size</label>
              <input type="number" value={config.websocket_pool_size} onChange={e => update('websocket_pool_size', parseInt(e.target.value))} className="w-full bg-dark-700 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-bnb" /></div>
            <div><label className="block text-sm text-gray-400 mb-1">Telegram Enabled</label>
              <input type="checkbox" checked={config.telegram_enabled} onChange={e => update('telegram_enabled', e.target.checked)} className="mt-2" /></div>
            <div><label className="block text-sm text-gray-400 mb-1">Telegram Token</label>
              <input type="text" value={config.telegram_token} onChange={e => update('telegram_token', e.target.value)} placeholder="Telegram Bot Token" className="w-full bg-dark-700 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-bnb" /></div>
            <div><label className="block text-sm text-gray-400 mb-1">Telegram Chat ID</label>
              <input type="text" value={config.telegram_chat_id} onChange={e => update('telegram_chat_id', e.target.value)} className="w-full bg-dark-700 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-bnb" /></div>
            <div className="col-span-2 mt-2 pt-4 border-t border-dark-600/60 space-y-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-bnb/90">Тест</div>
              <div className="flex flex-col gap-2.5 text-sm text-gray-300">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="tg-mode-modal" checked={tgTestMode === 'summary'} onChange={() => setTgTestMode('summary')} className="text-bnb" />
                  Тест: сводка
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="tg-mode-modal" checked={tgTestMode === 'balance'} onChange={() => setTgTestMode('balance')} className="text-bnb" />
                  Тест: баланс
                </label>
              </div>
              <button type="button" onClick={handleTelegramTest} disabled={tgTestLoading} className="w-full py-2.5 rounded-lg text-sm font-medium border border-dark-600 bg-dark-700 text-gray-200 hover:bg-dark-600 disabled:opacity-50">
                {tgTestLoading ? 'Отправка…' : 'Отправить тестовое уведомление'}
              </button>
              {tgTestFeedback ? (
                <p className={`text-xs ${tgTestFeedback.kind === 'err' ? 'text-amber-400' : 'text-emerald-400/90'}`}>{tgTestFeedback.text}</p>
              ) : null}
            </div>
            <div><label className="block text-sm text-gray-400 mb-1">Log Software</label>
              <input type="checkbox" checked={config.log_software} onChange={e => update('log_software', e.target.checked)} className="mt-2" /></div>
            <div><label className="block text-sm text-gray-400 mb-1">Log Orderbook</label>
              <input type="checkbox" checked={config.log_orderbook} onChange={e => update('log_orderbook', e.target.checked)} className="mt-2" /></div>
            <div><label className="block text-sm text-gray-400 mb-1">Log Orders</label>
              <input type="checkbox" checked={config.log_orders} onChange={e => update('log_orders', e.target.checked)} className="mt-2" /></div>
            <div><label className="block text-sm text-gray-400 mb-1">Place/Cancel All concurrency</label>
              <input type="number" min={1} max={100} value={config.orders_all_max_concurrent ?? 20} onChange={e => update('orders_all_max_concurrent', Math.min(100, Math.max(1, parseInt(e.target.value, 10) || 1)))} className="w-full bg-dark-700 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-bnb" /></div>
            <div><label className="block text-sm text-gray-400 mb-1">Market load concurrency</label>
              <input type="number" min={1} max={100} value={config.market_load_max_concurrent ?? 10} onChange={e => update('market_load_max_concurrent', Math.min(100, Math.max(1, parseInt(e.target.value, 10) || 1)))} className="w-full bg-dark-700 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-bnb" /></div>
          </div>
          <button onClick={handleSave} disabled={loading} className="w-full py-2.5 bg-bnb text-dark-900 rounded-lg text-sm font-semibold hover:bg-bnb-light transition-colors disabled:opacity-50">{loading ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}
