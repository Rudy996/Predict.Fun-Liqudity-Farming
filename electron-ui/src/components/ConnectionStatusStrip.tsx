import { type ReactNode } from 'react'
import { Shield } from 'lucide-react'
import { formatClockTime } from '../utils/ordersSummary'

interface ConnectionStatusStripProps {
  totalMarkets: number
  filteredCount: number
  searchActive: boolean
  prelim: number
  placed: number
  apiOrdersCount: number
  /** Сколько из открытых ордеров API — лимитки AutoSell (не ликвидность) */
  apiAutosellOpenCount?: number
  apiUpdatedAt: number
  inspectorEnabled: boolean
  onToggleInspector: () => void
  /** Кнопки справа (Выставить / Убрать / Общие) — на одной линии с «Можно выставить» */
  rightSlot?: ReactNode
}

export default function ConnectionStatusStrip({
  totalMarkets,
  filteredCount,
  searchActive,
  prelim,
  placed,
  apiOrdersCount,
  apiAutosellOpenCount = 0,
  apiUpdatedAt,
  inspectorEnabled,
  onToggleInspector,
  rightSlot,
}: ConnectionStatusStripProps) {
  const autosellSuffix =
    apiAutosellOpenCount > 0 ? ` (+${apiAutosellOpenCount} AutoSell)` : ''
  const apiLine = `${apiOrdersCount}${autosellSuffix} (${formatClockTime(apiUpdatedAt)})`

  return (
    <div className="flex flex-wrap items-stretch gap-3 px-4 py-2 bg-dark-900/60 border-b border-dark-600/90">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs uppercase tracking-wide text-gray-500 shrink-0">Рынков</span>
        <span className="text-sm font-semibold text-gray-100 tabular-nums">{totalMarkets}</span>
        {searchActive && (
          <span className="text-xs text-gray-500 truncate">
            · показано <span className="text-gray-300">{filteredCount}</span> из {totalMarkets}
          </span>
        )}
      </div>

      <div className="hidden sm:block w-px bg-dark-600 self-stretch my-0.5" aria-hidden />

      <div className="flex flex-1 flex-wrap items-center gap-3 sm:gap-5 min-w-0">
        <div className="flex items-center gap-4 rounded-lg bg-dark-800/90 border border-dark-600/60 px-3 py-1.5">
          <Metric label="Можно выставить" value={prelim} tone="emerald" />
          <div className="w-px h-8 bg-dark-600/80" />
          <Metric label="Выставлено" value={placed} tone="bnb" />
          <div className="w-px h-8 bg-dark-600/80" />
          <div
            className="min-w-[7rem]"
            title={
              apiAutosellOpenCount > 0
                ? 'Всего открытых ордеров по API; +N AutoSell — лимитки автопродажи (не ликвидность бота)'
                : 'Всего открытых ордеров по API (инспектор)'
            }
          >
            <div className="text-[10px] uppercase tracking-wide text-gray-500 leading-tight">API (открытых)</div>
            <div className="text-sm font-mono text-gray-200 tabular-nums leading-tight mt-0.5">{apiLine}</div>
          </div>
        </div>

        <button
          type="button"
          onClick={onToggleInspector}
          className={
            'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors shrink-0 ' +
            (inspectorEnabled
              ? 'border-bnb/50 bg-bnb/10 text-bnb hover:bg-bnb/15'
              : 'border-dark-600 bg-dark-800 text-gray-400 hover:text-gray-200 hover:border-dark-500')
          }
          title="Инспектор: сверка ордеров с API и отмена сирот"
        >
          <Shield size={14} strokeWidth={2} className={inspectorEnabled ? 'text-bnb' : 'opacity-70'} />
          Инспектор {inspectorEnabled ? 'вкл' : 'выкл'}
        </button>

        {rightSlot ? (
          <div className="flex w-full min-[520px]:w-auto min-[520px]:ml-auto shrink-0 items-center justify-end gap-2">
            {rightSlot}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: number; tone: 'emerald' | 'bnb' }) {
  const valCls = tone === 'emerald' ? 'text-emerald-400/95' : 'text-bnb'
  return (
    <div className="min-w-[5.5rem]">
      <div className="text-[10px] uppercase tracking-wide text-gray-500 leading-tight">{label}</div>
      <div className={'text-lg font-semibold tabular-nums leading-tight mt-0.5 ' + valCls}>{value}</div>
    </div>
  )
}
