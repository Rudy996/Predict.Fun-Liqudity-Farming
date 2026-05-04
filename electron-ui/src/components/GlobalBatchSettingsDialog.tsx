import { useState, useEffect, type ReactNode } from 'react'
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

interface GlobalBatchSettingsDialogProps {
  /** Все загруженные рынки — настройки применяются сразу ко всем */
  marketIds: string[]
  seed: TokenSettings | null
  onClose: () => void
  onApplied?: () => void | Promise<void>
}

export default function GlobalBatchSettingsDialog({
  marketIds,
  seed,
  onClose,
  onApplied,
}: GlobalBatchSettingsDialogProps) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [applyPosition, setApplyPosition] = useState(false)
  const [applyMinSpread, setApplyMinSpread] = useState(false)
  const [applyTargetLiq, setApplyTargetLiq] = useState(false)
  const [applyMaxSpread, setApplyMaxSpread] = useState(false)
  const [applyLiqMode, setApplyLiqMode] = useState(false)
  const [applyVolatile, setApplyVolatile] = useState(false)

  const [positionUnit, setPositionUnit] = useState<PositionUnit>('usdt')
  const [positionValue, setPositionValue] = useState('')
  const [minSpread, setMinSpread] = useState('')
  const [targetLiquidity, setTargetLiquidity] = useState(1000)
  const [maxAutoSpread, setMaxAutoSpread] = useState(6)
  const [liquidityMode, setLiquidityMode] = useState('bid')
  const [volatileLimit, setVolatileLimit] = useState(0)
  const [volatileWindow, setVolatileWindow] = useState(60)
  const [volatileCooldown, setVolatileCooldown] = useState(3600)

  useEffect(() => {
    if (!seed) return
    setPositionUnit(inferPositionUnit(seed))
    const u = inferPositionUnit(seed)
    const v = u === 'usdt' ? seed.position_size_usdt : seed.position_size_shares
    setPositionValue(v != null && v > 0 ? String(v) : '')
    setMinSpread(seed.min_spread != null ? String(seed.min_spread) : '')
    setTargetLiquidity(seed.target_liquidity)
    setMaxAutoSpread(seed.max_auto_spread)
    setLiquidityMode(seed.liquidity_mode === 'ask' ? 'ask' : 'bid')
    setVolatileLimit(seed.volatile_reposition_limit ?? 0)
    setVolatileWindow(seed.volatile_window_seconds ?? 60)
    setVolatileCooldown(seed.volatile_cooldown_seconds ?? 3600)
  }, [seed])

  const handleApply = async () => {
    setError('')
    if (marketIds.length === 0) {
      setError('Нет загруженных рынков')
      return
    }
    const hasField =
      applyPosition ||
      applyMinSpread ||
      applyTargetLiq ||
      applyMaxSpread ||
      applyLiqMode ||
      applyVolatile
    if (!hasField) {
      setError('Отметьте хотя бы одно поле для применения')
      return
    }

    const data: Partial<TokenSettings> = {}
    if (applyPosition) {
      const raw = positionValue.trim() === '' ? null : parseFloat(positionValue.replace(',', '.'))
      const num = raw != null && !Number.isNaN(raw) ? raw : null
      data.position_size_usdt = positionUnit === 'usdt' ? num : null
      data.position_size_shares = positionUnit === 'shares' ? num : null
    }
    if (applyMinSpread) {
      data.min_spread = minSpread.trim() === '' ? null : parseFloat(minSpread.replace(',', '.'))
    }
    if (applyTargetLiq) data.target_liquidity = targetLiquidity
    if (applyMaxSpread) data.max_auto_spread = maxAutoSpread
    if (applyLiqMode) data.liquidity_mode = liquidityMode
    if (applyVolatile) {
      data.volatile_reposition_limit = volatileLimit
      data.volatile_window_seconds = volatileWindow
      data.volatile_cooldown_seconds = volatileCooldown
    }

    setSaving(true)
    try {
      const r = await api.updateGlobalSettings(marketIds, data)
      if (r.success && (r.updated_count == null || r.updated_count > 0)) {
        await onApplied?.()
        onClose()
      } else {
        setError(r.error || (r.updated_count === 0 ? 'Сервер не обновил ни одного рынка (проверьте market_ids)' : 'Не удалось применить настройки'))
      }
    } catch {
      setError('Ошибка запроса')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[75] flex items-center justify-center bg-black/65 animate-fadeIn p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-xl bg-dark-800 border border-dark-600 rounded-xl shadow-2xl animate-slideDown max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-dark-600 sticky top-0 bg-dark-800/95 z-10">
          <h2 className="text-lg font-semibold text-gray-100 pr-2">Общие настройки</h2>
          <button type="button" onClick={onClose} className="p-1 text-gray-500 hover:text-gray-200 transition-colors shrink-0">
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {error ? <div className="text-sm text-danger">{error}</div> : null}

          <div className="space-y-3">
            <RowCheck checked={applyPosition} onCheck={setApplyPosition} label="Размер позиции">
              <div className="flex gap-2 items-center flex-wrap">
                <select
                  value={positionUnit}
                  onChange={e => {
                    setPositionUnit(e.target.value as PositionUnit)
                    setPositionValue('')
                  }}
                  className="bg-dark-700 border border-dark-600 rounded-lg px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-bnb"
                >
                  <option value="usdt">USDT</option>
                  <option value="shares">Shares</option>
                </select>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder={positionUnit === 'usdt' ? '100' : 'кол-во'}
                  value={positionValue}
                  onChange={e => setPositionValue(e.target.value)}
                  className="flex-1 min-w-[120px] bg-dark-700 border border-dark-600 rounded-lg px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-bnb"
                />
              </div>
            </RowCheck>

            <RowCheck checked={applyMinSpread} onCheck={setApplyMinSpread} label="Мин. спред (¢)">
              <input
                type="text"
                inputMode="decimal"
                value={minSpread}
                onChange={e => setMinSpread(e.target.value)}
                className="w-full bg-dark-700 border border-dark-600 rounded-lg px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-bnb"
              />
            </RowCheck>

            <RowCheck checked={applyTargetLiq} onCheck={setApplyTargetLiq} label="Целевая ликвидность ($)">
              <input
                type="text"
                inputMode="decimal"
                value={targetLiquidity}
                onChange={e => setTargetLiquidity(parseFloat(e.target.value) || 0)}
                className="w-full bg-dark-700 border border-dark-600 rounded-lg px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-bnb"
              />
            </RowCheck>

            <RowCheck checked={applyMaxSpread} onCheck={setApplyMaxSpread} label="Макс. авто-спред (¢)">
              <input
                type="text"
                inputMode="decimal"
                value={maxAutoSpread}
                onChange={e => setMaxAutoSpread(parseFloat(e.target.value) || 0)}
                className="w-full bg-dark-700 border border-dark-600 rounded-lg px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-bnb"
              />
            </RowCheck>

            <RowCheck checked={applyLiqMode} onCheck={setApplyLiqMode} label="Режим ликвидности">
              <select
                value={liquidityMode}
                onChange={e => setLiquidityMode(e.target.value)}
                className="w-full bg-dark-700 border border-dark-600 rounded-lg px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-bnb"
              >
                <option value="bid">По BID</option>
                <option value="ask">По ASK</option>
              </select>
            </RowCheck>

            <RowCheck checked={applyVolatile} onCheck={setApplyVolatile} label="Защита от волатильности (все три поля)">
              <div className="grid grid-cols-3 gap-2">
                <MiniField label="Лимит" value={volatileLimit} onChange={setVolatileLimit} integer />
                <MiniField label="Окно (сек)" value={volatileWindow} onChange={setVolatileWindow} />
                <MiniField label="Пауза (сек)" value={volatileCooldown} onChange={setVolatileCooldown} />
              </div>
            </RowCheck>
          </div>

          <div className="flex gap-2 pt-2 border-t border-dark-600">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 border border-dark-600 rounded-lg text-sm text-gray-300 hover:bg-dark-700"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={saving}
              className="flex-1 py-2.5 bg-bnb text-dark-900 rounded-lg text-sm font-semibold hover:bg-bnb-light disabled:opacity-50"
            >
              {saving ? 'Применение…' : 'Применить'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function RowCheck({
  checked,
  onCheck,
  label,
  children,
}: {
  checked: boolean
  onCheck: (v: boolean) => void
  label: string
  children: ReactNode
}) {
  return (
    <div className={`rounded-lg border p-2 ${checked ? 'border-bnb/50 bg-dark-900/40' : 'border-dark-600'}`}>
      <label className="flex items-start gap-2 cursor-pointer mb-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={e => onCheck(e.target.checked)}
          className="rounded border-dark-600 bg-dark-700 text-bnb focus:ring-bnb mt-0.5 shrink-0"
        />
        <span className="text-sm text-gray-200 font-medium">{label}</span>
      </label>
      <div className={checked ? '' : 'opacity-50 pointer-events-none'}>{children}</div>
    </div>
  )
}

function MiniField({
  label,
  value,
  onChange,
  integer,
}: {
  label: string
  value: number
  onChange: (n: number) => void
  integer?: boolean
}) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="text-[10px] text-gray-500 leading-tight h-8 flex items-end">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={e => {
          const t = e.target.value.replace(',', '.')
          const n = integer ? parseInt(t, 10) : parseFloat(t)
          onChange(Number.isFinite(n) ? n : 0)
        }}
        className="w-full bg-dark-700 border border-dark-600 rounded-lg px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-bnb"
      />
    </div>
  )
}
