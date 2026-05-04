import { useState } from 'react'
import { X } from 'lucide-react'
import { api } from '../api'
import { parseAddMarketInput } from '../utils/addMarketInput'
import CategoryPickDialog, { type CategoryMarketRow } from './CategoryPickDialog'

interface AddMarketDialogProps {
  onLoad: (ids: string[]) => Promise<void>
  onClose: () => void
}

function resolveCategoryImageUrl(url: string | null | undefined): string | null {
  if (!url?.trim()) return null
  const u = url.trim()
  if (u.startsWith('http://') || u.startsWith('https://')) return u
  return `https://api.predict.fun${u.startsWith('/') ? '' : '/'}${u}`
}

export default function AddMarketDialog({ onLoad, onClose }: AddMarketDialogProps) {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [categoryStep, setCategoryStep] = useState<{
    title: string
    imageUrl: string | null
    markets: CategoryMarketRow[]
  } | null>(null)

  const runLoadIds = async (ids: string[]) => {
    setLoading(true)
    setError('')
    try {
      await onLoad(ids)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    const parsed = parseAddMarketInput(text)
    if (!parsed) {
      setError('Вставьте ссылку predict.fun/market/… или Market ID (через запятую или с новой строки)')
      return
    }

    if (parsed.kind === 'ids') {
      await runLoadIds(parsed.ids)
      return
    }

    setLoading(true)
    try {
      const res = await api.fetchCategory(parsed.slug)
      if (res.error || !res.markets) {
        setError(res.error || 'Не удалось загрузить категорию')
        setLoading(false)
        return
      }
      const markets = (res.markets || []) as CategoryMarketRow[]
      const title = res.title || parsed.slug
      const imageUrl = resolveCategoryImageUrl(res.imageUrl ?? null)
      setCategoryStep({
        title,
        imageUrl,
        markets,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка запроса категории')
    } finally {
      setLoading(false)
    }
  }

  const handleCategoryConfirm = async (ids: string[]) => {
    setCategoryStep(null)
    await runLoadIds(ids)
  }

  if (categoryStep) {
    return (
      <CategoryPickDialog
        title={categoryStep.title}
        imageUrl={categoryStep.imageUrl}
        markets={categoryStep.markets}
        onConfirm={handleCategoryConfirm}
        onClose={() => setCategoryStep(null)}
      />
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fadeIn" onClick={onClose}>
      <div className="w-full max-w-md bg-dark-800 border border-dark-600 rounded-xl animate-slideDown" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-dark-600">
          <h2 className="text-lg font-semibold">Добавить рынок</h2>
          <button type="button" onClick={onClose} className="p-1 text-gray-500 hover:text-gray-200 transition-colors">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Ссылка или Market ID</label>
            <p className="text-xs text-gray-600 mb-2">
              Вставьте URL страницы рынка на predict.fun — откроется выбор из категории. Или укажите один или несколько ID через запятую / с новой строки.
            </p>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              rows={5}
              disabled={loading}
              className="w-full bg-dark-700 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-bnb transition-colors font-mono disabled:opacity-50"
              placeholder={
                'https://predict.fun/market/will-opinion-launch-a-token-by\nили\n12345, 67890'
              }
            />
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-bnb text-dark-900 rounded-lg text-sm font-semibold hover:bg-bnb-light transition-colors disabled:opacity-50"
          >
            {loading ? 'Загрузка…' : 'Далее'}
          </button>
        </form>
      </div>
    </div>
  )
}
