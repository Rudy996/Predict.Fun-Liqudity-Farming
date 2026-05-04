import type { MarketState } from '../types'

/** «Можно выставить» / «Выставлено» — как _update_orders_count в async_v3 gui.py */
export function computeOrdersSummary(markets: Record<string, MarketState>): { prelim: number; placed: number } {
  let prelim = 0
  let placed = 0
  for (const m of Object.values(markets)) {
    const oi = m.order_info
    if (oi && !m.collateral_cooldown) {
      if (oi.can_place_yes && !m.outcome_blocked_yes) prelim += 1
      if (oi.can_place_no && !m.outcome_blocked_no) prelim += 1
    }
    const ao = m.active_orders
    if (ao?.yes) placed += 1
    if (ao?.no) placed += 1
  }
  return { prelim, placed }
}

export function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr || '—'
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function formatClockTime(ts: number): string {
  if (!ts) return '—'
  try {
    return new Date(ts * 1000).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return '—'
  }
}
