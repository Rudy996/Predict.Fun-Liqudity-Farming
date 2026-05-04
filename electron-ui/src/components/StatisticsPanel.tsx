import { useEffect, useState } from 'react'
import { api } from '../api'
import type { StatsSnapshot } from '../types'
import { formatUptimeSeconds } from '../utils/formatUptime'

export default function StatisticsPanel() {
  const [stats, setStats] = useState<StatsSnapshot | null>(null)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const s = await api.getStats()
        if (!cancelled) setStats(s)
      } catch {
        if (!cancelled) setStats(null)
      }
    }
    void tick()
    const id = setInterval(tick, 1000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <h2 className="text-lg font-semibold text-gray-100">Статистика</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-dark-600 bg-dark-800 p-5 shadow-md">
          <h3 className="text-sm font-medium text-gray-300 mb-4">Общая статистика</h3>
          <div className="space-y-4">
            <div>
              <p className="text-xs text-gray-500 mb-1.5">Uptime</p>
              <p className="text-2xl font-mono text-bnb tabular-nums tracking-tight">
                {stats ? formatUptimeSeconds(stats.lifetime_uptime_sec) : '…'}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1.5">Срабатываний AutoSell</p>
              <p className="text-2xl font-mono text-gray-100 tabular-nums tracking-tight">
                {stats ? stats.autosell_triggers_lifetime : '…'}
              </p>
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-dark-600 bg-dark-800 p-5 shadow-md">
          <h3 className="text-sm font-medium text-gray-300 mb-4">Текущая сессия</h3>
          <div className="space-y-4">
            <div>
              <p className="text-xs text-gray-500 mb-1.5">Uptime</p>
              <p className="text-2xl font-mono text-emerald-400/90 tabular-nums tracking-tight">
                {stats ? formatUptimeSeconds(stats.session_uptime_sec) : '…'}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1.5">Срабатываний AutoSell</p>
              <p className="text-2xl font-mono text-gray-100 tabular-nums tracking-tight">
                {stats ? stats.autosell_triggers_session : '…'}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
