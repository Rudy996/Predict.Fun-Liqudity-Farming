import { useEffect, useState, useCallback } from 'react'
import { Activity, Clock3, Inbox, Loader2, Percent, Power, Radio, Settings, Sparkles } from 'lucide-react'
import SettingsCategory from './SettingsCategory'
import type { AutosellState, AutosellTrackedSell } from '../types'
import { api } from '../api'
import {
  formatOutcomeLabel,
  formatPredictTokenAmount,
  formatAvgBuyCentsOnly,
  formatUsdPosition,
  pickAveragePriceRaw,
} from '../utils/autosellFormat'

function fmtTime(ts: number): string {
  if (!ts) return '—'
  try {
    return new Date(ts * 1000).toLocaleTimeString()
  } catch {
    return '—'
  }
}

/** Тексты для пошагового прогресса первой загрузки (сервер: positions_load_stage). */
function autosellLoadingCopy(
  stage: string | undefined,
  enrich: { current: number; total: number } | null | undefined,
): { headline: string; sub: string; bar?: number } {
  switch (stage) {
    case 'requesting_positions':
      return {
        headline: 'Запрашиваем список позиций',
        sub: 'Обращаемся к Predict и получаем ваши открытые позиции.',
      }
    case 'enriching_markets': {
      const pr = enrich
      const sub =
        pr && pr.total > 0
          ? `Для каждой позиции подгружаем название рынка и картинку: ${pr.current} из ${pr.total}.`
          : 'Подгружаем названия и обложки рынков.'
      return {
        headline: 'Загружаем карточки рынков',
        sub,
        bar: pr && pr.total > 0 ? Math.min(100, Math.round((pr.current / pr.total) * 100)) : undefined,
      }
    }
    case 'assembling':
      return {
        headline: 'Собираем таблицу',
        sub: 'Готовим строки карточек по позициям.',
      }
    default:
      return {
        headline: 'Ищем ваши позиции',
        sub: 'Подключаемся к серверу и проверяем счёт…',
      }
  }
}

function DelayCountdown({ endsAt }: { endsAt: number }) {
  const [, setRerender] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setRerender(x => x + 1), 500)
    return () => window.clearInterval(id)
  }, [endsAt])
  const left = Math.max(0, Math.ceil(endsAt - Date.now() / 1000))
  return <span className="tabular-nums text-amber-200/95 font-medium">{left}</span>
}

function orderStatusRu(status: string): string {
  const s = (status || '').toLowerCase()
  if (s === 'delay') return 'Ожидание'
  if (s === 'open' || s === 'pending' || s === 'active') return 'В стакане'
  if (s === 'filled' || s === 'completed' || s === 'complete' || s === 'closed' || s === 'matched') return 'Исполнен'
  if (s === 'partially_filled' || s === 'partial') return 'Частично'
  if (s === 'cancelled' || s === 'canceled') return 'Отменён'
  if (s === 'expired') return 'Истёк'
  if (s === 'error') return 'Ошибка'
  if (s === 'invalidated') return 'Снят'
  return status || '—'
}

function TrackedSellRow({ row }: { row: AutosellTrackedSell }) {
  const lim = row.limit_price
  const limStr =
    lim != null && Number.isFinite(lim) ? formatAvgBuyCentsOnly(lim) : '—'
  const avgStr = row.avg_buy != null ? formatAvgBuyCentsOnly(row.avg_buy) : '—'
  const st = orderStatusRu(row.status)
  const isDelay = row.status === 'delay'
  const endsAt = row.delay_ends_at
  const expSec = row.order_expiration_sec
  const isOpenish = row.status === 'open' || row.status === 'partially_filled'
  const limitExpiresAt =
    isOpenish &&
    expSec != null &&
    Number.isFinite(expSec) &&
    expSec > 0 &&
    row.updated_at > 0
      ? row.updated_at + Number(expSec)
      : null
  const err = row.error?.trim()
  const fill =
    row.status === 'partially_filled' && row.amount_filled != null && row.amount_filled !== ''
      ? String(row.amount_filled)
      : null
  const sharesStr =
    row.shares != null && Number.isFinite(row.shares) && row.shares > 0
      ? formatPredictTokenAmount(row.shares, 6)
      : '—'
  const img = String(row.market_image ?? '').trim()
  const checkedAt = row.order_updated_at
  const mid = String(row.market_id ?? '').trim()

  return (
    <div className="border-b border-dark-600/80">
      <div className="flex gap-2 py-2.5 px-2 sm:px-3 text-xs sm:text-sm items-start">
        <div className="shrink-0 pt-0.5">
          {img ? (
            <img
              src={img}
              alt=""
              className="w-9 h-9 rounded-md object-cover bg-dark-700 border border-dark-600"
            />
          ) : (
            <div className="w-9 h-9 rounded-md bg-dark-700 border border-dark-600 flex items-center justify-center text-[10px] text-gray-600">
              m
            </div>
          )}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[repeat(8,minmax(0,1fr))] gap-x-1.5 gap-y-1 min-w-0 flex-1">
          <div className="lg:col-span-2 min-w-0">
            <div className="text-gray-200 font-medium truncate" title={row.title}>
              {row.title || '—'}
            </div>
            <div className="text-[11px] text-gray-500 font-mono break-all whitespace-normal">
              {mid ? `id: ${mid}` : '—'}
              {fill ? ` · заполнено ${fill}` : ''}
            </div>
          </div>
          <div className="lg:col-span-1 text-gray-300">
            <span className="text-gray-500 lg:hidden">исход </span>
            {formatOutcomeLabel(row.outcome)}
          </div>
          <div className="lg:col-span-1 text-gray-300 tabular-nums">
            <span className="text-gray-500 lg:hidden">AVG </span>
            {avgStr}
          </div>
          <div className="lg:col-span-1 text-amber-200/90 tabular-nums">
            <span className="text-gray-500 lg:hidden">лимит </span>
            {limStr}
          </div>
          <div className="lg:col-span-1 text-gray-300 tabular-nums">
            <span className="text-gray-500 lg:hidden">shares </span>
            {sharesStr}
          </div>
          <div className="lg:col-span-2 min-w-0">
            <span className="text-gray-500 lg:hidden text-[10px] uppercase">состояние </span>
            {isDelay && endsAt != null && Number.isFinite(endsAt) ? (
              <div className="text-gray-200 text-xs space-y-0.5">
                <div>Продажа начнётся через</div>
                <div className="text-base">
                  <DelayCountdown endsAt={endsAt} /> <span className="text-xs text-gray-500">сек</span>
                </div>
              </div>
            ) : limitExpiresAt != null ? (
              <div className="text-gray-200 text-xs space-y-0.5">
                <div className="text-gray-300">{st}</div>
                <div className="text-base">
                  <span className="text-[11px] text-gray-500 font-normal">Срок жизни лимитки: </span>
                  <DelayCountdown endsAt={limitExpiresAt} />{' '}
                  <span className="text-xs text-gray-500">сек</span>
                </div>
              </div>
            ) : (
              <div
                className={
                  row.status === 'error'
                    ? 'text-amber-400 text-xs'
                    : row.status === 'filled'
                      ? 'text-emerald-400/90 text-xs'
                      : 'text-gray-300 text-xs'
                }
              >
                {st}
              </div>
            )}
            {checkedAt && !isDelay ? (
              <div className="text-[10px] text-gray-600 mt-0.5 tabular-nums">
                Статус: {fmtTime(checkedAt)}
              </div>
            ) : null}
            {err ? (
              <div className="text-[11px] text-amber-400/90 mt-0.5 break-words" title={err}>
                {err}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function PositionRow({ p }: { p: Record<string, unknown> }) {
  const displayTitle = String(
    p._display_market_title ?? p.title ?? p.marketTitle ?? p.question ?? p.name ?? ''
  ).trim()
  const nested = p.market && typeof p.market === 'object' ? (p.market as Record<string, unknown>) : null
  const mid = p.marketId ?? p.market_id ?? nested?.id ?? p.id
  const img = String(p._display_market_image ?? nested?.image ?? nested?.imageUrl ?? '').trim()
  const outcome = formatOutcomeLabel(p.outcome ?? p.side ?? p.token)
  const sharesRaw = p.shares ?? p.amount ?? p.size ?? p.quantity
  const avgRaw = pickAveragePriceRaw(p)
  const usd = p._display_value_usd
  return (
    <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 py-2.5 px-3 border-b border-dark-600/80 text-xs sm:text-sm items-center">
      <div className="sm:col-span-3 min-w-0 flex gap-2">
        {img ? (
          <img
            src={img}
            alt=""
            className="w-9 h-9 rounded-md object-cover shrink-0 bg-dark-700 border border-dark-600"
          />
        ) : (
          <div className="w-9 h-9 rounded-md shrink-0 bg-dark-700 border border-dark-600 flex items-center justify-center text-[10px] text-gray-600">
            m
          </div>
        )}
        <div className="min-w-0">
          <div
            className="text-gray-200 truncate font-medium"
            title={displayTitle || String(mid ?? '')}
          >
            {displayTitle || `Рынок ${String(mid ?? '—')}`}
          </div>
          {mid != null && (
            <div className="text-[11px] text-gray-500 font-mono truncate">id: {String(mid)}</div>
          )}
        </div>
      </div>
      <div className="sm:col-span-2 text-gray-300 break-words">{outcome}</div>
      <div className="sm:col-span-2 text-gray-300 tabular-nums">{formatPredictTokenAmount(sharesRaw, 6)}</div>
      <div className="sm:col-span-2 text-gray-200 tabular-nums">{formatAvgBuyCentsOnly(avgRaw)}</div>
      <div className="sm:col-span-2 text-emerald-400/90 tabular-nums font-medium">{formatUsdPosition(usd)}</div>
    </div>
  )
}

export default function AutosellPanel({ connected }: { connected: boolean }) {
  const [state, setState] = useState<AutosellState | null>(null)
  const [err, setErr] = useState('')
  const [intervalDraft, setIntervalDraft] = useState('5')
  const [lossDraft, setLossDraft] = useState('15')
  const [orderPollDraft, setOrderPollDraft] = useState('3')
  const [delayDraft, setDelayDraft] = useState('0')
  const [expirationDraft, setExpirationDraft] = useState('0')
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [autosellSettingsOpen, setAutosellSettingsOpen] = useState(false)
  const [toggleSaving, setToggleSaving] = useState(false)

  const load = useCallback(async () => {
    setErr('')
    try {
      const s = await api.getAutosell()
      setState(s)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, connected])

  useEffect(() => {
    if (state?.poll_interval_sec != null) {
      setIntervalDraft(String(state.poll_interval_sec))
    }
  }, [state?.poll_interval_sec])

  useEffect(() => {
    if (state?.max_loss_percent != null) {
      setLossDraft(String(state.max_loss_percent))
    }
  }, [state?.max_loss_percent])

  useEffect(() => {
    if (state?.order_status_interval_sec != null) {
      setOrderPollDraft(String(state.order_status_interval_sec))
    }
  }, [state?.order_status_interval_sec])

  useEffect(() => {
    if (state?.delay_before_sell_sec != null) {
      setDelayDraft(String(state.delay_before_sell_sec))
    }
  }, [state?.delay_before_sell_sec])

  useEffect(() => {
    if (state?.order_expiration_sec != null) {
      setExpirationDraft(String(state.order_expiration_sec))
    }
  }, [state?.order_expiration_sec])

  const pollSec = Math.max(1, state?.poll_interval_sec ?? 5)
  const orderPollSec = Math.max(1, state?.order_status_interval_sec ?? 3)
  const uiRefreshSec = Math.min(pollSec, orderPollSec)
  const positionsReady = state?.positions_first_fetch_done === true
  /** Пока state не пришёл — считаем включённым (как в конфиге по умолчанию), чтобы не мигать «выкл». */
  const autosellOn = state === null ? true : state.autosell_enabled === true

  useEffect(() => {
    if (!connected || positionsReady) return
    const id = window.setInterval(() => void load(), 320)
    return () => window.clearInterval(id)
  }, [connected, positionsReady, load])

  useEffect(() => {
    if (!connected || !positionsReady || state?.autosell_enabled === false) return
    const id = window.setInterval(() => void load(), uiRefreshSec * 1000)
    return () => window.clearInterval(id)
  }, [connected, positionsReady, uiRefreshSec, load, state?.autosell_enabled])

  const applySettings = async () => {
    const rawI = intervalDraft.replace(',', '.').trim()
    const rawL = lossDraft.replace(',', '.').trim()
    const rawO = orderPollDraft.replace(',', '.').trim()
    const rawD = delayDraft.replace(',', '.').trim()
    const rawE = expirationDraft.replace(',', '.').trim()
    const vi = parseFloat(rawI)
    const vl = parseFloat(rawL)
    const vo = parseFloat(rawO)
    const vd = parseFloat(rawD)
    const ve = parseFloat(rawE)
    if (!Number.isFinite(vi) || vi < 1) {
      setErr('Интервал позиций: число от 1 секунды')
      return
    }
    if (!Number.isFinite(vo) || vo < 1 || vo > 300) {
      setErr('Интервал ордеров: от 1 до 300 секунд')
      return
    }
    if (!Number.isFinite(vl) || vl < 0.1 || vl > 95) {
      setErr('Макс. минус от AVG: от 0.1 до 95 (без знака «−» в поле)')
      return
    }
    if (!Number.isFinite(vd) || vd < 0 || vd > 86400) {
      setErr('Пауза перед продажей: от 0 (выкл.) до 86400 сек (24 ч)')
      return
    }
    if (!Number.isFinite(ve) || ve < 0 || ve > 2592000) {
      setErr('Срок жизни ордера: 0 (по умолчанию API) или 120…2592000 сек (30 сут.)')
      return
    }
    if (ve > 0 && ve < 120) {
      setErr(
        'Срок жизни лимитки: укажите 0 (дефолт SDK) или не меньше 120 с — иначе API отвечает create_order_expiry_too_soon'
      )
      return
    }
    const intervalClamped = Math.min(86400, Math.max(1, vi))
    const lossClamped = Math.min(95, Math.max(0.1, vl))
    const orderPollClamped = Math.min(300, Math.max(1, vo))
    const delayClamped = Math.min(86400, Math.max(0, vd))
    const expClamped = Math.min(2592000, Math.max(0, ve))
    setSettingsSaving(true)
    setErr('')
    try {
      const r = await api.setAutosellSettings({
        interval_sec: intervalClamped,
        max_loss_percent: lossClamped,
        order_status_interval_sec: orderPollClamped,
        delay_before_sell_sec: delayClamped,
        order_expiration_sec: expClamped,
      })
      if (!r.success) {
        setErr(r.error || 'Не удалось сохранить')
        return
      }
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSettingsSaving(false)
    }
  }

  const toggleAutosell = async (next: boolean) => {
    setToggleSaving(true)
    setErr('')
    try {
      const r = await api.setAutosellSettings({ enabled: next })
      if (!r.success) {
        setErr(r.error || 'Не удалось сохранить')
        return
      }
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setToggleSaving(false)
    }
  }

  if (!connected) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <div className="rounded-xl border border-dark-600 bg-dark-800/80 p-8 text-center text-gray-400">
          <Activity className="w-10 h-10 mx-auto mb-3 opacity-50" />
          <p className="text-sm">Подключите аккаунт, чтобы видеть позиции и настраивать интервал обновления.</p>
        </div>
      </div>
    )
  }

  const positions = state?.positions ?? []
  const tracked = state?.tracked_sells ?? []
  const loadingPositions = !positionsReady
  const loadCopy = loadingPositions
    ? autosellLoadingCopy(state?.positions_load_stage, state?.positions_enrich_progress ?? null)
    : null

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-100 mb-1">AutoSell</h2>
        <p className="text-sm text-gray-500">Автопродажа новых позиций по правилу AVG − N%. Можно полностью отключить.</p>
      </div>

      <div
        className={`rounded-2xl p-[1px] shadow-lg transition-shadow duration-300 ${
          autosellOn
            ? 'bg-gradient-to-br from-emerald-500/45 via-bnb/35 to-cyan-500/35 shadow-emerald-500/10'
            : 'bg-gradient-to-br from-dark-500/80 to-dark-600/90'
        }`}
      >
        <div className="rounded-2xl bg-dark-800/98 backdrop-blur-sm px-4 py-4 sm:px-6 sm:py-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-3 min-w-0">
              <div
                className={`shrink-0 w-11 h-11 rounded-xl flex items-center justify-center ${
                  autosellOn ? 'bg-emerald-500/15 ring-1 ring-emerald-500/35' : 'bg-dark-700 ring-1 ring-dark-500/80'
                }`}
              >
                <Power
                  className={`w-5 h-5 ${autosellOn ? 'text-emerald-400' : 'text-gray-500'}`}
                  strokeWidth={2}
                />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-semibold text-gray-100">Состояние</span>
                  <span
                    className={`text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${
                      autosellOn
                        ? 'bg-emerald-500/20 text-emerald-300/95 ring-1 ring-emerald-500/30'
                        : 'bg-dark-600 text-gray-500 ring-1 ring-dark-500/90'
                    }`}
                  >
                    {autosellOn ? 'Включён' : 'Выключен'}
                  </span>
                </div>
                <p className="text-sm text-gray-500 mt-1 leading-relaxed">
                  {autosellOn
                    ? 'Идёт опрос позиций и при появлении новых — выставление лимитов на продажу.'
                    : 'Опрос API и автопродажа не выполняются. Настройки ниже сохраняются для следующего включения.'}
                </p>
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={autosellOn}
              disabled={toggleSaving || state === null}
              onClick={() => void toggleAutosell(!autosellOn)}
              className={`relative shrink-0 h-11 w-[7.25rem] rounded-full transition-all duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-bnb/60 focus-visible:ring-offset-2 focus-visible:ring-offset-dark-900 disabled:opacity-45 ${
                autosellOn
                  ? 'bg-emerald-600 shadow-[0_0_24px_-6px_rgba(16,185,129,0.65)]'
                  : 'bg-dark-600'
              }`}
            >
              <span
                className={`pointer-events-none absolute top-1 left-1 h-9 w-9 rounded-full bg-white shadow-md transition-transform duration-300 ease-out ${
                  /* трек w-[7.25rem] − left-1 − right-1 − кружок w-9 = 7.25 − 0.5 − 2.25 = 4.5rem */
                  autosellOn ? 'translate-x-[calc(7.25rem-2.75rem)]' : 'translate-x-0'
                }`}
              />
              <span className="sr-only">{autosellOn ? 'Выключить AutoSell' : 'Включить AutoSell'}</span>
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <SettingsCategory
          title="Настройки AutoSell"
          subtitle="Опрос API, дисконт от AVG, пауза и срок жизни лимитки — всё в одном блоке"
          open={autosellSettingsOpen}
          onToggle={() => setAutosellSettingsOpen(o => !o)}
          iconSlot={
            <div className="w-8 h-8 rounded-lg bg-bnb/15 flex items-center justify-center ring-1 ring-bnb/25">
              <Settings className="w-4 h-4 text-bnb" strokeWidth={2} />
            </div>
          }
        >
          <div className="space-y-6 pt-1">
            <section className="space-y-3">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-cyan-500/20 flex items-center justify-center shrink-0">
                  <Radio className="w-3.5 h-3.5 text-cyan-400" strokeWidth={2} />
                </div>
                <div>
                  <h4 className="text-xs font-semibold text-gray-200 tracking-wide">Опрос API</h4>
                  <p className="text-[11px] text-gray-500 mt-0.5">Позиции и статус лимиток</p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-5">
                <div className="space-y-1.5 min-w-0">
                  <label className="block text-xs text-gray-400">Позиции, сек</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={intervalDraft}
                    onChange={e => setIntervalDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void applySettings()
                    }}
                    className="w-full max-w-[11rem] bg-dark-700/90 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 font-mono focus:outline-none focus:border-bnb"
                  />
                  <p className="text-[11px] text-gray-500 leading-relaxed">
                    Частота запроса списка открытых позиций (1…86400).
                  </p>
                </div>
                <div className="space-y-1.5 min-w-0">
                  <label className="block text-xs text-gray-400">Ордера автопродажи, сек</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={orderPollDraft}
                    onChange={e => setOrderPollDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void applySettings()
                    }}
                    className="w-full max-w-[11rem] bg-dark-700/90 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 font-mono focus:outline-none focus:border-bnb"
                  />
                  <p className="text-[11px] text-gray-500 leading-relaxed">
                    Обновление статуса лимиток в блоке «Новая позиция» (1…300).
                  </p>
                </div>
              </div>
            </section>

            <div className="border-t border-dark-600/55" />

            <section className="space-y-3">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-amber-500/20 flex items-center justify-center shrink-0">
                  <Percent className="w-3.5 h-3.5 text-amber-400" strokeWidth={2} />
                </div>
                <div>
                  <h4 className="text-xs font-semibold text-gray-200 tracking-wide">Цена лимитной продажи</h4>
                  <p className="text-[11px] text-gray-500 mt-0.5">Максимальная скидка от AVG buy</p>
                </div>
              </div>
              <div className="space-y-1.5 min-w-0 max-w-md">
                <label className="block text-xs text-gray-400">Макс. минус от AVG buy</label>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-lg text-gray-400 font-medium select-none" title="Скидка от средней покупки">
                    −
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={lossDraft}
                    onChange={e => setLossDraft(e.target.value.replace(/[^\d.,]/g, ''))}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void applySettings()
                    }}
                    className="w-24 bg-dark-700/90 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 font-mono focus:outline-none focus:border-bnb"
                    aria-label="Процент максимальной скидки от средней покупки"
                  />
                  <span className="text-sm text-gray-500">%</span>
                </div>
                <p className="text-[11px] text-gray-500 leading-relaxed">
                  Лимитная продажа не ниже средней минус этот процент (с шагом цены рынка).
                </p>
              </div>
            </section>

            <div className="border-t border-dark-600/55" />

            <section className="space-y-3">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-violet-500/20 flex items-center justify-center shrink-0">
                  <Clock3 className="w-3.5 h-3.5 text-violet-400" strokeWidth={2} />
                </div>
                <div>
                  <h4 className="text-xs font-semibold text-gray-200 tracking-wide">Тайминг</h4>
                  <p className="text-[11px] text-gray-500 mt-0.5">Пауза перед лимитом и срок жизни в подписи</p>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
                <div className="space-y-1.5 min-w-0">
                  <label className="block text-xs text-gray-400">Пауза перед продажей, сек</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={delayDraft}
                    onChange={e => setDelayDraft(e.target.value.replace(/[^\d.,]/g, ''))}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void applySettings()
                    }}
                    className="w-full max-w-[11rem] bg-dark-700/90 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 font-mono focus:outline-none focus:border-bnb"
                  />
                  <p className="text-[11px] text-gray-500 leading-relaxed">
                    0 — сразу. Иначе ждём N секунд (отсчёт в карточке), затем автопродажа.
                  </p>
                </div>
                <div className="space-y-1.5 min-w-0">
                  <label className="block text-xs text-gray-400">Срок жизни лимитки, сек</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={expirationDraft}
                    onChange={e => setExpirationDraft(e.target.value.replace(/[^\d.,]/g, ''))}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void applySettings()
                    }}
                    className="w-full max-w-[12rem] bg-dark-700/90 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 font-mono focus:outline-none focus:border-bnb"
                  />
                  <p className="text-[11px] text-gray-500 leading-relaxed">
                    0 — срок по умолчанию SDK. Иначе не меньше 120 с (иначе POST /orders даёт create_order_expiry_too_soon);
                    по истечении ордер снимается; статус не опрашиваем после исполнения / отмены / истечения.
                  </p>
                </div>
              </div>
            </section>

            <div className="border-t border-dark-600/55 pt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={settingsSaving}
                onClick={() => void applySettings()}
                className="rounded-lg px-4 py-2 text-sm border border-dark-600 bg-dark-900 text-gray-200 hover:border-bnb/50 disabled:opacity-50"
              >
                {settingsSaving ? '…' : 'Сохранить'}
              </button>
            </div>
          </div>
        </SettingsCategory>
      </div>

      {err ? <p className="text-sm text-amber-400">{err}</p> : null}

      {!autosellOn ? (
        <div className="rounded-xl border border-dark-600/90 bg-dark-800/90 overflow-hidden">
          <div className="px-6 py-14 text-center max-w-lg mx-auto">
            <div className="inline-flex w-14 h-14 rounded-2xl bg-dark-700/90 ring-1 ring-dark-500/80 items-center justify-center mb-5">
              <Power className="w-7 h-7 text-gray-500" strokeWidth={1.5} />
            </div>
            <p className="text-gray-100 font-medium text-base mb-2">AutoSell выключен</p>
            <p className="text-sm text-gray-500 leading-relaxed">
              Позиции не опрашиваются, лимиты на продажу не выставляются. Включите переключатель выше — настройка
              сохраняется и после перезапуска приложения останется такой, какой вы её оставили.
            </p>
          </div>
        </div>
      ) : (
        <>
      <div className="rounded-xl border border-dark-600 bg-dark-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-dark-600 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles className="w-4 h-4 text-amber-400/90 shrink-0" />
            <span className="text-sm font-medium text-gray-200">Новая позиция → автопродажа</span>
          </div>
          <div className="flex flex-col items-end sm:flex-row sm:items-center gap-1 sm:gap-3 text-xs text-gray-500 shrink-0">
            <span>{tracked.length ? `${tracked.length} в ленте` : 'пока пусто'}</span>
            {state && positionsReady && state.positions_updated_at ? (
              <span className="tabular-nums whitespace-nowrap">
                Позиции обновлены: {fmtTime(state.positions_updated_at)}
              </span>
            ) : null}
          </div>
        </div>
        {tracked.length === 0 ? (
          <div className="px-6 py-8 text-center text-sm text-gray-500">
            После первой загрузки списка позиций любая <span className="text-gray-400">новая</span> позиция
            получит лимитную заявку на продажу по правилу выше. Здесь — AVG, лимит, shares, id рынка и блок
            состояния с временем опроса.
          </div>
        ) : (
          <>
            <div className="hidden lg:flex gap-2 px-2 sm:px-3 py-2 bg-dark-900/50 text-[11px] uppercase tracking-wide text-gray-500 border-b border-dark-600">
              <div className="w-9 shrink-0" aria-hidden />
              <div className="grid grid-cols-[repeat(8,minmax(0,1fr))] gap-1.5 flex-1 min-w-0">
                <div className="col-span-2">Рынок / id</div>
                <div className="col-span-1">Исход</div>
                <div className="col-span-1">AVG</div>
                <div className="col-span-1">Лимит</div>
                <div className="col-span-1">Shares</div>
                <div className="col-span-2">Состояние</div>
              </div>
            </div>
            <div className="max-h-[min(360px,45vh)] overflow-y-auto">
              {tracked.map(row => (
                <TrackedSellRow key={`${row.position_id}-${row.updated_at}`} row={row} />
              ))}
            </div>
          </>
        )}
      </div>

      <div className="rounded-xl border border-dark-600 bg-dark-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-dark-600 flex items-center gap-2">
          <Radio className="w-4 h-4 text-bnb" />
          <span className="text-sm font-medium text-gray-200">Открытые позиции</span>
          <span className="text-xs text-gray-500 ml-auto">
            {loadingPositions ? 'загрузка…' : `${positions.length} шт.`}
          </span>
        </div>
        {loadingPositions && loadCopy ? (
          <div className="px-6 py-12 text-center">
            <Loader2 className="w-10 h-10 mx-auto text-bnb animate-spin mb-4" aria-hidden />
            <p className="text-gray-100 font-medium mb-2 text-base">{loadCopy.headline}</p>
            <p className="text-sm text-gray-500 max-w-md mx-auto mb-6 leading-relaxed">{loadCopy.sub}</p>
            <div className="max-w-sm mx-auto h-2 rounded-full bg-dark-700 overflow-hidden">
              {loadCopy.bar != null ? (
                <div
                  className="h-full rounded-full bg-bnb/55 transition-[width] duration-300 ease-out"
                  style={{ width: `${loadCopy.bar}%` }}
                />
              ) : (
                <div className="h-full w-2/5 rounded-full bg-bnb/40 animate-pulse" />
              )}
            </div>
          </div>
        ) : positions.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <Inbox className="w-11 h-11 mx-auto text-gray-600 mb-4" strokeWidth={1.25} aria-hidden />
            <p className="text-gray-100 font-medium mb-2">Открытых позиций нет</p>
            <p className="text-sm text-gray-500 max-w-md mx-auto leading-relaxed">
              Сейчас на аккаунте нет открытых позиций. Когда появятся новые, они появятся в этом списке
              (обновление по выбранному интервалу).
            </p>
          </div>
        ) : (
          <>
            <div className="hidden sm:grid grid-cols-12 gap-2 px-3 py-2 bg-dark-900/50 text-[11px] uppercase tracking-wide text-gray-500 border-b border-dark-600">
              <div className="col-span-3">Рынок</div>
              <div className="col-span-2">Исход</div>
              <div className="col-span-2">Shares</div>
              <div className="col-span-2">AVG buy</div>
              <div className="col-span-2">Стоимость</div>
            </div>
            <div className="max-h-[min(420px,50vh)] overflow-y-auto">
              {positions.map((p, i) => (
                <PositionRow key={i} p={p} />
              ))}
            </div>
          </>
        )}
      </div>
        </>
      )}
    </div>
  )
}
