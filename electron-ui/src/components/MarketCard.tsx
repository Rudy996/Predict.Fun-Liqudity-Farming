import { useState, useEffect } from 'react'
import { ExternalLink, Settings, Trash2, CheckCircle, XCircle, ChevronDown, ChevronUp, Sparkles } from 'lucide-react'
import type { MarketState } from '../types'
import { openExternalUrl } from '../utils/openExternalUrl'
import { predictFunMarketUrl } from '../utils/predictFunMarketUrl'
import { fmtFixed, safeNum } from '../utils/safeNumber'

function formatCooldownRemaining(untilUnixSec: number): string {
  const ms = Math.max(0, untilUnixSec * 1000 - Date.now())
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) {
    return `${h}ч ${String(m).padStart(2, '0')}м ${String(s).padStart(2, '0')}с`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

function isRewardPeriodActiveNow(period: { startsAt: string; endsAt: string }): boolean {
  const t = Date.now()
  const s = Date.parse(period.startsAt)
  const e = Date.parse(period.endsAt)
  if (Number.isNaN(s) || Number.isNaN(e)) return false
  return t >= s && t < e
}

function useCooldownRemainingLabel(
  inCooldown: boolean,
  untilUnixSec: number | null | undefined,
): string {
  const [label, setLabel] = useState('')
  useEffect(() => {
    if (!inCooldown || untilUnixSec == null || Number.isNaN(untilUnixSec)) {
      setLabel('')
      return
    }
    const tick = () => {
      const ms = Math.max(0, untilUnixSec * 1000 - Date.now())
      if (ms <= 0) {
        setLabel('0:00')
        return
      }
      setLabel(formatCooldownRemaining(untilUnixSec))
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [inCooldown, untilUnixSec])
  return label
}

interface MarketCardProps {
  state: MarketState
  onRemove: () => void
  onSettings: () => void
  /** После place/cancel — refetch состояния рынка, чтобы полоска «Можно выставить» и кнопки не ждали SSE */
  onOrdersChanged?: () => void
  /** Открыть журнал и подсветить строки (все подстроки должны совпасть) */
  onOpenLogsWithHighlight?: (terms: string[]) => void
}

export default function MarketCard({ state, onRemove, onSettings, onOrdersChanged, onOpenLogsWithHighlight }: MarketCardProps) {
  const [showDetails, setShowDetails] = useState(false)
  const [placing, setPlacing] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [placeError, setPlaceError] = useState('')

  const oi = state.order_info
  const settings = state.settings
  const activeYes = state.active_orders?.yes
  const activeNo = state.active_orders?.no
  const hasActiveOrders = Boolean(activeYes || activeNo)
  /** Слежение за рынком после Place (arm) — как async_v3: Cancel = выйти из слежения и снять ордера. */
  const liquidityWatching = Boolean(state.liquidity_session_armed) || hasActiveOrders

  /** Как async_v3 MarketCard + Calculator.calculate_limit_orders: best bid/ask YES, mid = (bid+ask)/2 */
  const bestBid = oi?.best_bid_yes ?? state.best_bid ?? 0
  const bestAsk = oi?.best_ask_yes ?? state.best_ask ?? 0
  const midYesBook = (bestBid + bestAsk) / 2
  /** NO: лучший bid NO = 1 − yes_ask, лучший ask NO = 1 − yes_bid (как в gui.py: no_mid, no_bid, no_ask = 1−mid, 1−ask, 1−bid) */
  const noBid = 1 - bestAsk
  const noAsk = 1 - bestBid
  const midNoBook = (noBid + noAsk) / 2
  /** В Qt стакан: .2f в центах — иначе 17.05¢ при toFixed(1) превращается в «17.1» и совпадает с ask */
  const c = (p: number) => fmtFixed(safeNum(p) * 100, 2)

  const updateTime = state.update_time
    ? new Date(state.update_time * 1000).toLocaleTimeString()
    : '--'

  const marketPageUrl = predictFunMarketUrl(state.slug, state.categorySlug, state.market_id)

  const activeReward =
    state.rewards?.current &&
    typeof state.rewards.current.hourlyRate === 'number' &&
    isRewardPeriodActiveNow(state.rewards.current)
      ? state.rewards.current
      : null

  /** После отмены ордеров сервер может ввести паузу «защиты от волатильности» — тогда can_place в ответе принудительно false, а ликвидность в цифрах остаётся «как по книге». */
  const volatileLiquidityPause = state.liquidity_volatile_in_cooldown === true
  const volatileCooldownLabel = useCooldownRemainingLabel(
    volatileLiquidityPause,
    state.liquidity_volatile_cooldown_until ?? null,
  )

  /** Пауза после ответа API insufficient collateral (длительность — global insufficient_collateral_cooldown_sec). */
  const collateralLiquidityPause = state.collateral_cooldown === true
  const collateralCooldownLabel = useCooldownRemainingLabel(
    collateralLiquidityPause,
    state.collateral_cooldown_until ?? null,
  )

  const pointsRewardBlocked = oi?.predict_points_blocked === true

  /** Немедленно слать лимитки в API только если калькулятор разрешает; иначе только слежка — выставит поток по тикам. */
  const tryImmediatePlaceBoth =
    oi != null &&
    Boolean(oi.buy_yes && oi.buy_no) &&
    oi.can_place_yes === true &&
    oi.can_place_no === true &&
    !pointsRewardBlocked &&
    !volatileLiquidityPause &&
    !collateralLiquidityPause &&
    !state.outcome_blocked_yes &&
    !state.outcome_blocked_no

  const preliminarySideStatus = (side: 'yes' | 'no'): string => {
    if (pointsRewardBlocked) return 'Нет награды (Points)'
    if (volatileLiquidityPause) return 'Пауза (волатильность)'
    if (collateralLiquidityPause) return 'Пауза (залог)'
    if (side === 'yes' && state.outcome_blocked_yes) return 'Блок (точность)'
    if (side === 'no' && state.outcome_blocked_no) return 'Блок (точность)'
    return (side === 'yes' ? oi?.can_place_yes : oi?.can_place_no) ? 'Can place' : 'Cannot place'
  }

  const handlePlaceLiquidity = async () => {
    setPlaceError('')
    setPlacing(true)
    try {
      const { api } = await import('../api')
      const arm = await api.armLiquiditySession(state.market_id)
      if (!arm.success) {
        setPlaceError(arm.error || 'Не удалось включить слежение за рынком')
        return
      }
      if (!tryImmediatePlaceBoth || !oi?.buy_yes || !oi?.buy_no) {
        return
      }
      const rYes = await api.placeOrder(state.market_id, 'yes', oi.buy_yes.price, oi.buy_yes.shares)
      if (!rYes.success) {
        const msg = rYes.error || 'Не удалось выставить ордер YES'
        setPlaceError(`YES: ${msg}`)
        return
      }
      const rNo = await api.placeOrder(state.market_id, 'no', oi.buy_no.price, oi.buy_no.shares)
      if (!rNo.success) {
        const msg = rNo.error || 'Не удалось выставить ордер NO'
        setPlaceError(`NO: ${msg}`)
        return
      }
    } catch (e) {
      const t = e instanceof Error ? e.message : String(e)
      setPlaceError(t)
    } finally {
      setPlacing(false)
      onOrdersChanged?.()
    }
  }

  const handleCancelOrders = async () => {
    setCancelling(true)
    try {
      const { api } = await import('../api')
      await api.cancelOrder(state.market_id, 'manual')
    } finally {
      setCancelling(false)
      onOrdersChanged?.()
    }
  }

  return (
    <div className="w-[440px] bg-dark-800 border border-dark-600 rounded-xl overflow-hidden animate-card-in hover:border-dark-500 transition-colors duration-200">
      {/* Header */}
      <div className="flex items-center gap-3 p-3 border-b border-dark-600">
        {state.imageUrl ? (
          <img src={state.imageUrl} alt="" className="w-10 h-10 rounded-lg object-cover" />
        ) : (
          <div className="w-10 h-10 rounded-lg bg-dark-700 flex items-center justify-center text-gray-500 text-xs">
            IMG
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">{state.title || state.market_id}</span>
            {marketPageUrl ? (
              <button
                type="button"
                onClick={() => openExternalUrl(marketPageUrl)}
                className="text-gray-500 hover:text-bnb transition-colors p-0 border-0 bg-transparent cursor-pointer"
                title="Открыть рынок в браузере"
              >
                <ExternalLink size={14} />
              </button>
            ) : null}
          </div>
          <p className="text-xs text-gray-500 truncate">{state.question}</p>
          {activeReward ? (
            <div
              className="mt-1.5 flex items-center gap-1.5 w-fit max-w-full rounded-lg border border-amber-500/35 bg-amber-500/10 px-2 py-1 text-[11px] leading-tight text-amber-100/95"
              title={`Активный буст по Predict Points до ${new Date(activeReward.endsAt).toLocaleString()}`}
            >
              <Sparkles size={12} className="shrink-0 text-amber-300/90" aria-hidden />
              <span className="truncate">
                <span className="text-amber-200/80">Predict Points</span>
                <span className="mx-1 text-amber-500/60">·</span>
                <span className="font-semibold tabular-nums text-amber-50">
                  {Math.round(activeReward.hourlyRate).toLocaleString('en-US')}
                </span>
                <span className="text-amber-200/75">/hr</span>
              </span>
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onSettings} className="p-1 text-gray-500 hover:text-bnb transition-colors" title="Settings">
            <Settings size={14} />
          </button>
          <button onClick={onRemove} className="p-1 text-gray-500 hover:text-danger transition-colors" title="Remove">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Orderbook — только обновление цифр и времени последнего стакана */}
      <div className="p-3 border-b border-dark-600">
        <div className="text-xs text-gray-500 mb-2 font-medium">Orderbook</div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs text-success font-medium mb-1">YES</div>
            <div className="space-y-0.5 text-xs font-mono">
              <div className="flex justify-between tabular-nums">
                <span className="text-gray-500">Mid</span>
                <span className="text-gray-300 transition-colors duration-200">{c(midYesBook)}c</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Bid</span>
                <span className="text-success">{c(bestBid)}c</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Ask</span>
                <span className="text-danger">{c(bestAsk)}c</span>
              </div>
            </div>
          </div>
          <div>
            <div className="text-xs text-warning font-medium mb-1">NO</div>
            <div className="space-y-0.5 text-xs font-mono">
              <div className="flex justify-between">
                <span className="text-gray-500">Mid</span>
                <span className="text-gray-300">{c(midNoBook)}c</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Bid</span>
                <span className="text-success">{c(noBid)}c</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Ask</span>
                <span className="text-danger">{c(noAsk)}c</span>
              </div>
            </div>
          </div>
        </div>
        <div className="text-[10px] text-gray-600 mt-2 flex justify-between">
          <span>Стакан получен</span>
          <span className="text-gray-500 tabular-nums">{updateTime}</span>
        </div>
      </div>

      {/* Preliminary Orders */}
      {oi && (
        <div className="p-3 border-b border-dark-600">
          <div className="mb-2">
            <div className="text-xs text-gray-500 font-medium">Preliminary Orders</div>
            {volatileLiquidityPause ? (
              <div
                className="mt-0.5 text-[11px] text-gray-400 tabular-nums"
                title="Защита от волатильности: лимит переставлений в окне (настройки volatile_*). До снятия паузы выставление заблокировано."
              >
                Пауза (волатильность)
                {volatileCooldownLabel ? ` · осталось ${volatileCooldownLabel}` : ''}
              </div>
            ) : null}
            {collateralLiquidityPause ? (
              <div
                className="mt-0.5 text-[11px] text-gray-400 tabular-nums"
                title="Ответ API: недостаточно залога (insufficient collateral). Пауза на рынок по глобальной настройке insufficient collateral cooldown."
              >
                Пауза (залог)
                {collateralCooldownLabel ? ` · осталось ${collateralCooldownLabel}` : ''}
              </div>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-success font-medium mb-1">YES</div>
              {oi.buy_yes ? (
                <div className="space-y-0.5 text-xs font-mono">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Price</span>
                    <span className="text-gray-300">{fmtFixed(safeNum(oi.buy_yes.price) * 100, 1)}c</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500" title="Округление до 0.1 share, как в калькуляторе и при отправке ордера">
                      Shares
                    </span>
                    <span className="text-gray-300">{fmtFixed(oi.buy_yes.shares, 1)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500" title="Глубина стакана до цены ордера (BID/ASK по режиму)">
                      Ликв. книги
                    </span>
                    <span className="text-gray-300">${fmtFixed(oi.liquidity_yes, 0)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Сумма ордера</span>
                    <span className="text-gray-300">${fmtFixed(oi.buy_yes.value_usd, 2)}</span>
                  </div>
                  <div className="flex items-center gap-1 mt-1">
                    {oi.can_place_yes &&
                    !volatileLiquidityPause &&
                    !collateralLiquidityPause &&
                    !state.outcome_blocked_yes ? (
                      <CheckCircle size={12} className="text-success" />
                    ) : (
                      <XCircle size={12} className="text-danger" />
                    )}
                    <span className="text-[10px] text-gray-500">{preliminarySideStatus('yes')}</span>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-gray-600">No data</div>
              )}
            </div>
            <div>
              <div className="text-xs text-warning font-medium mb-1">NO</div>
              {oi.buy_no ? (
                <div className="space-y-0.5 text-xs font-mono">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Price</span>
                    <span className="text-gray-300">{fmtFixed(safeNum(oi.buy_no.price) * 100, 1)}c</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500" title="Округление до 0.1 share, как в калькуляторе и при отправке ордера">
                      Shares
                    </span>
                    <span className="text-gray-300">{fmtFixed(oi.buy_no.shares, 1)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500" title="Глубина стакана до цены ордера (BID/ASK по режиму)">
                      Ликв. книги
                    </span>
                    <span className="text-gray-300">${fmtFixed(oi.liquidity_no, 0)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Сумма ордера</span>
                    <span className="text-gray-300">${fmtFixed(oi.buy_no.value_usd, 2)}</span>
                  </div>
                  <div className="flex items-center gap-1 mt-1">
                    {oi.can_place_no &&
                    !volatileLiquidityPause &&
                    !collateralLiquidityPause &&
                    !state.outcome_blocked_no ? (
                      <CheckCircle size={12} className="text-success" />
                    ) : (
                      <XCircle size={12} className="text-danger" />
                    )}
                    <span className="text-[10px] text-gray-500">{preliminarySideStatus('no')}</span>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-gray-600">No data</div>
              )}
            </div>
          </div>
          <div className="text-xs text-gray-500 mt-2 text-center">
            Total: <span className="text-bnb font-medium">${fmtFixed(oi.total_value_usd, 2)}</span>
          </div>
        </div>
      )}

      {/* Placed Orders */}
      {(activeYes || activeNo) && (
        <div className="p-3 border-b border-dark-600">
          <div className="text-xs text-gray-500 mb-2 font-medium">Placed Orders</div>
          <div className="grid grid-cols-2 gap-3 text-xs font-mono">
            {activeYes && (
              <div>
                <span className="text-success">YES</span>
                <span className="text-gray-400 ml-2">{fmtFixed(safeNum(activeYes.price) * 100, 1)}c - {fmtFixed(activeYes.shares, 1)}</span>
              </div>
            )}
            {activeNo && (
              <div>
                <span className="text-warning">NO</span>
                <span className="text-gray-400 ml-2">{fmtFixed(safeNum(activeNo.price) * 100, 1)}c - {fmtFixed(activeNo.shares, 1)}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Settings Summary */}
      {settings && (
        <div className="p-3 border-b border-dark-600">
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors w-full"
          >
            {showDetails ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            Settings
          </button>
          {showDetails && (
            <div className="grid grid-cols-2 gap-2 mt-2 text-xs font-mono">
              <div className="flex justify-between">
                <span className="text-gray-500">Size</span>
                <span className="text-gray-300">${settings.position_size_usdt ?? '-'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Target Liq.</span>
                <span className="text-gray-300">${settings.target_liquidity}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Min Spread</span>
                <span className="text-gray-300">{settings.min_spread}c</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Max Spread</span>
                <span className="text-gray-300">{settings.max_auto_spread}c</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Mode</span>
                <span className="text-gray-300">{(settings.liquidity_mode ?? '').toUpperCase() || '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Enabled</span>
                <span className={settings.enabled ? 'text-success' : 'text-danger'}>
                  {settings.enabled ? 'Yes' : 'No'}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Place = слежка за рынком (arm); при готовности preliminary — сразу две лимитки. Cancel = снять слежку и отменить лимиты. */}
      <div className="p-3">
        {liquidityWatching ? (
          <button
            type="button"
            onClick={handleCancelOrders}
            disabled={cancelling}
            className="w-full py-2 bg-danger/10 border border-danger/30 text-danger rounded-lg text-sm font-medium hover:bg-danger/20 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {cancelling ? 'Отмена…' : 'Cancel Liquidity'}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={handlePlaceLiquidity}
              disabled={placing}
              className="w-full py-2 bg-bnb/10 border border-bnb/30 text-bnb rounded-lg text-sm font-medium hover:bg-bnb/20 transition-all duration-200 disabled:opacity-45 disabled:cursor-not-allowed"
            >
              {placing ? 'Placing…' : 'Place Liquidity'}
            </button>
            {placeError ? (
              <div className="mt-2 rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-2 text-xs text-danger/95 leading-snug">
                <div className="font-medium text-danger mb-0.5">Не выставлено</div>
                <p className="text-gray-300 break-words">{placeError}</p>
                {onOpenLogsWithHighlight ? (
                  <button
                    type="button"
                    onClick={() => onOpenLogsWithHighlight([state.market_id, '✗'])}
                    className="mt-1.5 text-bnb hover:underline text-[11px]"
                  >
                    Открыть журнал с подсветкой
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
