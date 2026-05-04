import { useState, useMemo } from 'react'
import { X } from 'lucide-react'

const STATUS_REGISTERED = 'REGISTERED'

export interface CategoryMarketRow {
  id: string
  title: string
  status?: string
  resolution?: { name?: string }
}

interface CategoryPickDialogProps {
  title: string
  imageUrl: string | null | undefined
  markets: CategoryMarketRow[]
  onConfirm: (ids: string[]) => void
  onClose: () => void
}

export default function CategoryPickDialog({
  title,
  imageUrl,
  markets,
  onConfirm,
  onClose,
}: CategoryPickDialogProps) {
  const rows = useMemo(() => {
    const out: { id: string; label: string }[] = []
    for (const m of markets) {
      const status = (m.status || '').trim().toUpperCase()
      if (status !== STATUS_REGISTERED) continue
      const mid = String(m.id ?? '')
      if (!mid) continue
      const titleM = m.title || mid
      const outcome = m.resolution?.name || ''
      const label = outcome ? `${titleM} — ${outcome}` : titleM
      out.push({
        id: mid,
        label: label.length > 90 ? `${label.slice(0, 87)}...` : label,
      })
    }
    return out
  }, [markets])

  const [selected, setSelected] = useState<Record<string, boolean>>(() => {
    const s: Record<string, boolean> = {}
    for (const r of rows) s[r.id] = true
    return s
  })

  const toggle = (id: string) => setSelected(prev => ({ ...prev, [id]: !prev[id] }))

  const selectAll = () => {
    const s: Record<string, boolean> = {}
    for (const r of rows) s[r.id] = true
    setSelected(s)
  }

  const deselectAll = () => {
    const s: Record<string, boolean> = {}
    for (const r of rows) s[r.id] = false
    setSelected(s)
  }

  const handleAdd = () => {
    const ids = rows.map(r => r.id).filter(id => selected[id])
    if (ids.length === 0) return
    onConfirm(ids)
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-[1px]" onClick={onClose}>
      <div
        className="w-full max-w-lg max-h-[85vh] bg-dark-800 border border-dark-600 rounded-xl flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-4 p-4 border-b border-dark-600">
          {imageUrl ? (
            <img src={imageUrl} alt="" className="w-24 h-24 rounded-lg object-cover bg-dark-700 shrink-0" />
          ) : (
            <div className="w-24 h-24 rounded-lg bg-dark-700 shrink-0 flex items-center justify-center text-gray-600 text-xs">IMG</div>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-gray-100 leading-snug">{title}</h2>
            <p className="text-xs text-gray-500 mt-1">Выберите рынки (только REGISTERED)</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-gray-500 hover:text-gray-200 shrink-0">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-2 space-y-1 min-h-[120px] max-h-[45vh]">
          {rows.length === 0 ? (
            <p className="text-sm text-gray-500 py-4 text-center">Нет рынков со статусом REGISTERED</p>
          ) : (
            rows.map(r => (
              <label
                key={r.id}
                className="flex items-start gap-3 py-2.5 px-2 rounded-lg border border-transparent hover:border-dark-600 hover:bg-dark-700/40 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selected[r.id] ?? false}
                  onChange={() => toggle(r.id)}
                  className="mt-1 rounded border-dark-600 bg-dark-700 text-bnb focus:ring-bnb"
                />
                <span className="text-sm text-gray-300 leading-snug">{r.label}</span>
              </label>
            ))
          )}
        </div>

        <div className="flex flex-wrap gap-2 px-4 py-2 border-t border-dark-600/80">
          <button type="button" onClick={selectAll} className="px-3 py-1.5 text-xs rounded-lg bg-dark-700 border border-dark-600 text-gray-300 hover:border-bnb/40">
            Выбрать все
          </button>
          <button type="button" onClick={deselectAll} className="px-3 py-1.5 text-xs rounded-lg bg-dark-700 border border-dark-600 text-gray-300 hover:border-bnb/40">
            Убрать все
          </button>
        </div>

        <div className="flex gap-2 p-4 border-t border-dark-600">
          <button type="button" onClick={onClose} className="flex-1 py-2.5 bg-dark-700 border border-dark-600 rounded-lg text-sm text-gray-300 hover:bg-dark-600">
            Отмена
          </button>
          <button
            type="button"
            onClick={handleAdd}
            disabled={rows.length === 0 || !rows.some(r => selected[r.id])}
            className="flex-1 py-2.5 bg-bnb text-dark-900 rounded-lg text-sm font-semibold hover:bg-bnb-light disabled:opacity-45 disabled:cursor-not-allowed"
          >
            Добавить выбранные
          </button>
        </div>
      </div>
    </div>
  )
}
