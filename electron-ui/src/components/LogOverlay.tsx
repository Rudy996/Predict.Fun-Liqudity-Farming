import { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react'
import { X, Filter, Trash2 } from 'lucide-react'
import type { LogMessage } from '../types'

interface LogOverlayProps {
  logs: LogMessage[]
  onClose: () => void
  /** Очистить буфер логов на сервере и в UI */
  onClear?: () => void | Promise<void>
  /** Подсветить строки, в которых есть **все** эти подстроки; первая прокручивается в видимую область */
  highlightContainsAll?: string[]
}

const levelColors: Record<string, string> = {
  info: 'text-gray-300',
  warning: 'text-warning',
  error: 'text-danger',
  success: 'text-success',
}

function formatLogTime(ts: number): string {
  const d = new Date(ts * 1000)
  const pad = (n: number, w: number) => String(n).padStart(w, '0')
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`
}

const SCROLL_BOTTOM_PX = 72

export default function LogOverlay({ logs, onClose, onClear, highlightContainsAll }: LogOverlayProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const firstHighlightRef = useRef<HTMLDivElement>(null)
  /** Прокрутка вниз только если пользователь уже у низа — иначе новые логи не дергают вид */
  const stickToBottomRef = useRef(true)
  const [filter, setFilter] = useState<string>('all')

  const onScrollPane = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = dist <= SCROLL_BOTTOM_PX
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickToBottomRef.current) return
    if (highlightContainsAll?.length) return
    el.scrollTop = el.scrollHeight
  }, [logs, filter, highlightContainsAll])

  useEffect(() => {
    if (highlightContainsAll?.length) setFilter('all')
  }, [highlightContainsAll])

  const filteredLogs = filter === 'all' ? logs : logs.filter(l => l.level === filter)

  const firstHighlightIndex = useMemo(() => {
    if (!highlightContainsAll?.length) return -1
    return filteredLogs.findIndex(l =>
      highlightContainsAll.every(sub => sub && l.message.includes(sub)),
    )
  }, [filteredLogs, highlightContainsAll])

  /** Сразу позиция на строке с ошибкой до paint — без анимации «сверху вниз» */
  useLayoutEffect(() => {
    if (firstHighlightIndex < 0) return
    const container = scrollRef.current
    const row = firstHighlightRef.current
    if (!container || !row) return
    const relTop = row.offsetTop
    const centered = relTop - container.clientHeight / 2 + row.offsetHeight / 2
    container.scrollTop = Math.max(0, Math.min(centered, container.scrollHeight - container.clientHeight))
  }, [firstHighlightIndex, filteredLogs.length, highlightContainsAll])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-[2px] animate-fadeIn" onClick={onClose}>
      <div className="w-[92vw] max-w-4xl h-[82vh] bg-dark-800/95 border border-dark-600/80 rounded-2xl shadow-2xl shadow-black/40 flex flex-col animate-slideDown overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-dark-600/80 bg-dark-800/80">
          <div>
            <h2 className="text-base font-semibold text-gray-100">Журнал</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              События и сообщения приложения
              {highlightContainsAll?.length ? (
                <span className="text-bnb ml-1">· подсветка по выбранным подстрокам</span>
              ) : null}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {onClear ? (
              <button
                type="button"
                onClick={() => void onClear()}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-gray-400 border border-dark-600 bg-dark-700 hover:text-amber-400/95 hover:border-amber-500/35 transition-colors"
                title="Очистить журнал на сервере и в интерфейсе"
              >
                <Trash2 size={14} strokeWidth={2} />
                Очистить
              </button>
            ) : null}
            <div className="flex items-center gap-1">
              <Filter size={14} className="text-gray-500" />
              {['all', 'info', 'warning', 'error'].map(level => (
                <button key={level} onClick={() => setFilter(level)}
                  className={`px-2 py-0.5 rounded text-xs transition-colors ${filter === level ? 'bg-bnb/20 text-bnb border border-bnb/30' : 'bg-dark-700 text-gray-500 border border-dark-600'}`}>
                  {level === 'all' ? 'All' : level}
                </button>
              ))}
            </div>
            <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-200 transition-colors"><X size={18} /></button>
          </div>
        </div>
        <div
          ref={scrollRef}
          onScroll={onScrollPane}
          className="flex-1 overflow-y-auto px-5 py-4 font-mono text-[13px] leading-snug space-y-1.5 bg-dark-900/40"
        >
          {filteredLogs.length === 0 ? (
            <p className="text-gray-500 text-sm font-sans">Пока нет записей…</p>
          ) : (
            filteredLogs.map((log, i) => {
              const hl = Boolean(
                highlightContainsAll?.length &&
                  highlightContainsAll.every(sub => sub && log.message.includes(sub)),
              )
              return (
                <div
                  key={`${log.timestamp}-${i}`}
                  ref={i === firstHighlightIndex ? firstHighlightRef : undefined}
                  className={`${levelColors[log.level] || 'text-gray-300'} rounded-lg px-2 py-1 hover:bg-dark-700/50 transition-colors ${
                    hl ? 'ring-1 ring-bnb/50 bg-bnb/10' : ''
                  }`}
                >
                  <span className="text-gray-600 mr-2 tabular-nums shrink-0">{formatLogTime(log.timestamp)}</span>
                  {log.message}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
