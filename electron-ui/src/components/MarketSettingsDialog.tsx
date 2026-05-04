import { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { api } from '../api'
import type { TokenSettings } from '../types'

type PositionUnit = 'usdt' | 'shares'

function inferPositionUnit(s: TokenSettings): PositionUnit {
  const u = s.position_size_usdt
  const sh = s.position_size_shares
  if (sh != null && sh > 0 && (u == null || u <= 0)) return 'shares'
  return 'usdt'
}

interface MarketSettingsDialogProps {
  marketId: string
  marketTitle?: string
  onClose: () => void
  /** Сервер возвращает settings + settings_updated_at — карточка обновляется сразу, без гонки с SSE */
  onSaved?: (result: { settings: TokenSettings; settings_updated_at: number }) => void
}

export default function MarketSettingsDialog({ marketId, marketTitle, onClose, onSaved }: MarketSettingsDialogProps) {
  const [settings, setSettings] = useState<TokenSettings | null>(null)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)

  const [positionUnit, setPositionUnit] = useState<PositionUnit>('usdt')
  const [positionValue, setPositionValue] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoadError('')
    api
      .getMarketSettings(marketId)
      .then(s => {
        if (!cancelled) {
          setSettings(s)
          const u = inferPositionUnit(s)
          setPositionUnit(u)
          const v = u === 'usdt' ? s.position_size_usdt : s.position_size_shares
          setPositionValue(v != null && v > 0 ? String(v) : '')
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError('Не удалось загрузить настройки')
      })
    return () => {
      cancelled = true
    }
  }, [marketId])

  const update = (key: keyof TokenSettings, value: unknown) =>
    setSettings(prev => (prev ? { ...prev, [key]: value } : prev))

  const handleSave = async () => {
    if (!settings) return
    setSaving(true)
    try {
      const raw = positionValue.trim() === '' ? null : parseFloat(positionValue.replace(',', '.'))
      const num = raw != null && !Number.isNaN(raw) ? raw : null
      const { enabled: _enabledControlledByPlaceCancel, ...rest } = settings
      const payload: Partial<TokenSettings> = {
        ...rest,
        position_size_usdt: positionUnit === 'usdt' ? num : null,
        position_size_shares: positionUnit === 'shares' ? num : null,
      }
      const res = await api.updateMarketSettings(marketId, payload)
      if (res.success && res.settings) {
        onSaved?.({
          settings: res.settings,
          settings_updated_at: res.settings_updated_at ?? 0,
        })
        onClose()
      }
    } finally {
      setSaving(false)
    }
  }

  const title = marketTitle || marketId

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/65 animate-fadeIn p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-lg bg-dark-800 border border-dark-600 rounded-xl shadow-2xl animate-slideDown max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-dark-600 sticky top-0 bg-dark-800/95 z-10">
          <h2 className="text-lg font-semibold text-gray-100 pr-2">Настройки рынка</h2>
          <button type="button" onClick={onClose} className="p-1 text-gray-500 hover:text-gray-200 transition-colors shrink-0">
            <X size={18} />
          </button>
        </div>

        {loadError && <div className="p-4 text-sm text-danger">{loadError}</div>}

        {!settings && !loadError && <div className="p-8 text-center text-gray-500 text-sm">Загрузка…</div>}

        {settings && (
          <div className="p-4 space-y-5">
            <p className="text-xs text-gray-500 line-clamp-2">{title}</p>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Размер позиции</label>
                <div className="flex gap-2 flex-wrap items-stretch">
                  <select
                    value={positionUnit}
                    onChange={e => {
                      setPositionUnit(e.target.value as PositionUnit)
                      setPositionValue('')
                    }}
                    className="bg-dark-700 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-bnb shrink-0"
                  >
                    <option value="usdt">USDT</option>
                    <option value="shares">Shares</option>
                  </select>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder={positionUnit === 'usdt' ? 'например 100' : 'кол-во shares'}
                    value={positionValue}
                    onChange={e => setPositionValue(e.target.value)}
                    className="flex-1 min-w-[140px] bg-dark-700 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-bnb"
                  />
                </div>
                <p className="text-[11px] text-gray-600 mt-1">Задаётся одно значение: либо USDT, либо shares (второе сбрасывается).</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <NumField
                  label="Целевая ликвидность ($)"
                  value={settings.target_liquidity}
                  onChange={v => update('target_liquidity', v)}
                />
                <NumField
                  label="Мин. спред (¢)"
                  value={settings.min_spread}
                  onChange={v => update('min_spread', v)}
                  allowEmpty
                />
                <NumField
                  label="Макс. авто-спред (¢)"
                  value={settings.max_auto_spread}
                  onChange={v => update('max_auto_spread', v)}
                />
                <div>
                  <label className="block text-xs text-gray-500 mb-1 h-8 flex items-end">Режим ликвидности</label>
                  <select
                    value={settings.liquidity_mode}
                    onChange={e => update('liquidity_mode', e.target.value)}
                    className="w-full bg-dark-700 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-bnb"
                  >
                    <option value="bid">По BID</option>
                    <option value="ask">По ASK</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="border-t border-dark-600 pt-4">
              <h3 className="text-sm font-medium text-gray-300 mb-1">Защита от волатильности</h3>
              <p className="text-[11px] text-gray-500 mb-3">
                Лимит переставлений в окне; 0 = выкл. При автоторговле ограничивает частоту смены ордеров.
              </p>
              <div className="grid grid-cols-3 gap-3">
                <VolField
                  label="Лимит переставлений"
                  sub="0 = выкл"
                  value={settings.volatile_reposition_limit ?? 0}
                  onChange={v => update('volatile_reposition_limit', v)}
                  integer
                />
                <VolField
                  label="Окно (сек)"
                  value={settings.volatile_window_seconds ?? 60}
                  onChange={v => update('volatile_window_seconds', v)}
                />
                <VolField
                  label="Пауза (сек)"
                  value={settings.volatile_cooldown_seconds ?? 3600}
                  onChange={v => update('volatile_cooldown_seconds', v)}
                />
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2.5 border border-dark-600 rounded-lg text-sm text-gray-300 hover:bg-dark-700"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="flex-1 py-2.5 bg-bnb text-dark-900 rounded-lg text-sm font-semibold hover:bg-bnb-light disabled:opacity-50"
              >
                {saving ? 'Сохранение…' : 'Сохранить'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function NumField({
  label,
  value,
  onChange,
  allowEmpty,
}: {
  label: string
  value: number | string | null
  onChange: (v: number | null) => void
  allowEmpty?: boolean
}) {
  const display =
    value === null || value === undefined || value === ''
      ? ''
      : typeof value === 'number'
        ? String(value)
        : value
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <label className="block text-xs text-gray-500 h-8 flex items-end leading-tight">{label}</label>
      <input
        type="text"
        inputMode="decimal"
        value={display}
        onChange={e => {
          const t = e.target.value.trim()
          if (allowEmpty && t === '') {
            onChange(null)
            return
          }
          const n = parseFloat(t.replace(',', '.'))
          onChange(Number.isFinite(n) ? n : 0)
        }}
        className="w-full bg-dark-700 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-bnb"
      />
    </div>
  )
}

function VolField({
  label,
  sub,
  value,
  onChange,
  integer,
}: {
  label: string
  sub?: string
  value: number
  onChange: (v: number) => void
  integer?: boolean
}) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <label className="block text-[11px] text-gray-500 h-10 flex flex-col justify-end leading-tight">
        <span>{label}</span>
        {sub ? <span className="text-gray-600">{sub}</span> : null}
      </label>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={e => {
          const t = e.target.value.replace(',', '.')
          const n = integer ? parseInt(t, 10) : parseFloat(t)
          onChange(Number.isFinite(n) ? n : 0)
        }}
        className="w-full bg-dark-700 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-bnb"
      />
    </div>
  )
}
