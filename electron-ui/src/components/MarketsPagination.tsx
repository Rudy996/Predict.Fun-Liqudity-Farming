import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'

const PAGE_SIZE_OPTIONS = [10, 20, 30, 50, 100, 200] as const

export function readStoredMarketsPageSize(): number {
  if (typeof window === 'undefined') return 30
  const raw = localStorage.getItem('pf_markets_page_size')
  const n = raw ? parseInt(raw, 10) : 30
  return PAGE_SIZE_OPTIONS.includes(n as (typeof PAGE_SIZE_OPTIONS)[number]) ? n : 30
}

interface MarketsPaginationProps {
  totalItems: number
  page: number
  pageSize: number
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
}

export default function MarketsPagination({
  totalItems,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: MarketsPaginationProps) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
  const safePage = Math.min(Math.max(1, page), totalPages)
  const from = totalItems === 0 ? 0 : (safePage - 1) * pageSize + 1
  const to = Math.min(safePage * pageSize, totalItems)

  const go = (p: number) => {
    const next = Math.min(Math.max(1, p), totalPages)
    onPageChange(next)
  }

  const windowPages = (): number[] => {
    const maxButtons = 7
    if (totalPages <= maxButtons) {
      return Array.from({ length: totalPages }, (_, i) => i + 1)
    }
    const half = Math.floor(maxButtons / 2)
    let start = safePage - half
    let end = safePage + half
    if (start < 1) {
      start = 1
      end = maxButtons
    }
    if (end > totalPages) {
      end = totalPages
      start = Math.max(1, end - maxButtons + 1)
    }
    return Array.from({ length: end - start + 1 }, (_, i) => start + i)
  }

  const pages = windowPages()

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-dark-800/80 border-b border-dark-600/80">
      <div className="text-sm text-gray-400">
        {totalItems === 0 ? (
          <span>Нет рынков в выборке</span>
        ) : (
          <span>
            Показано{' '}
            <span className="text-gray-200 font-medium tabular-nums">
              {from}–{to}
            </span>
            {' '}из{' '}
            <span className="text-gray-200 font-medium tabular-nums">{totalItems}</span>
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <label className="flex items-center gap-2 text-sm text-gray-400">
          <span className="hidden sm:inline">На странице</span>
          <select
            value={pageSize}
            onChange={e => onPageSizeChange(parseInt(e.target.value, 10))}
            className="bg-dark-700 border border-dark-600 rounded-lg px-2.5 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-bnb min-w-[4.5rem]"
          >
            {PAGE_SIZE_OPTIONS.map(n => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => go(1)}
            disabled={safePage <= 1 || totalItems === 0}
            className="p-1.5 rounded-lg border border-dark-600 bg-dark-700 text-gray-300 hover:bg-dark-600 hover:text-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Первая страница"
          >
            <ChevronsLeft size={18} />
          </button>
          <button
            type="button"
            onClick={() => go(safePage - 1)}
            disabled={safePage <= 1 || totalItems === 0}
            className="p-1.5 rounded-lg border border-dark-600 bg-dark-700 text-gray-300 hover:bg-dark-600 hover:text-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Назад"
          >
            <ChevronLeft size={18} />
          </button>

          <div className="flex items-center gap-0.5 px-1">
            {pages.map(pn => (
              <button
                key={pn}
                type="button"
                onClick={() => go(pn)}
                className={
                  'min-w-[2rem] h-8 px-1.5 rounded-md text-sm font-medium tabular-nums transition-colors ' +
                  (pn === safePage
                    ? 'bg-bnb text-dark-900'
                    : 'text-gray-400 hover:bg-dark-700 hover:text-gray-200')
                }
              >
                {pn}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => go(safePage + 1)}
            disabled={safePage >= totalPages || totalItems === 0}
            className="p-1.5 rounded-lg border border-dark-600 bg-dark-700 text-gray-300 hover:bg-dark-600 hover:text-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Вперёд"
          >
            <ChevronRight size={18} />
          </button>
          <button
            type="button"
            onClick={() => go(totalPages)}
            disabled={safePage >= totalPages || totalItems === 0}
            className="p-1.5 rounded-lg border border-dark-600 bg-dark-700 text-gray-300 hover:bg-dark-600 hover:text-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Последняя страница"
          >
            <ChevronsRight size={18} />
          </button>
        </div>

        <span className="text-xs text-gray-500 tabular-nums hidden sm:inline">
          Стр. {safePage} / {totalPages}
        </span>
      </div>
    </div>
  )
}
