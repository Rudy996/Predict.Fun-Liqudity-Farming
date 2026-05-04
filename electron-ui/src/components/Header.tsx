import { Wallet, Activity, Bell } from 'lucide-react'
import SocialCtaButtons from './SocialCtaButtons'
import { fmtFixed } from '../utils/safeNumber'

interface HeaderProps {
  connected: boolean
  wsConnected: boolean
  balance: number
  /** Unix sec — время последнего обновления баланса на сервере */
  balanceUpdatedAt?: number
  /** Подпись аккаунта: ник или 0xabcd…1234 */
  accountLabel: string
  onConnect: () => void
  connectLoading?: boolean
  onOpenLogs?: () => void
  logCount?: number
}

export default function Header({
  connected, wsConnected, balance, balanceUpdatedAt,
  accountLabel,
  onConnect, connectLoading = false,
  onOpenLogs,
  logCount = 0,
}: HeaderProps) {
  return (
    <div className="flex items-center gap-2 sm:gap-3 px-4 py-2.5 bg-dark-800 border-b border-dark-600">
      <div className="flex items-center gap-2 min-w-0 shrink-0">
        <div className="w-7 h-7 rounded-lg bg-bnb flex items-center justify-center">
          <span className="text-dark-900 font-bold text-xs">PF</span>
        </div>
        <span className="font-semibold text-sm hidden sm:block">PredictFun</span>
      </div>

      <SocialCtaButtons />

      <div className="flex-1 min-w-[0.5rem]" />

      {connected ? (
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          {accountLabel ? (
            <span className="text-sm text-gray-300 font-medium truncate max-w-[min(200px,40vw)]" title={accountLabel}>
              {accountLabel}
            </span>
          ) : null}
          <div className="flex items-center gap-1.5 text-sm min-w-0">
            <Wallet size={14} className="text-bnb shrink-0" />
            <span className="text-gray-300 tabular-nums">${fmtFixed(balance, 2, '0.00')}</span>
            {balanceUpdatedAt ? (
              <span className="text-[11px] text-gray-500 tabular-nums shrink-0" title="Время последнего опроса баланса">
                ({new Date(balanceUpdatedAt * 1000).toLocaleTimeString()})
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5">
            <div className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-success' : 'bg-danger'}`} />
            <span className="text-xs text-gray-400">{wsConnected ? 'WS' : 'Offline'}</span>
          </div>
          {onOpenLogs && (
            <button
              type="button"
              onClick={onOpenLogs}
              className="relative p-2 rounded-lg bg-dark-700 border border-dark-600 text-gray-400 hover:text-bnb hover:border-bnb/40 transition-colors"
              title="Журнал событий"
            >
              <Bell size={18} strokeWidth={1.75} />
              {logCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-bnb text-[10px] font-bold text-dark-900 leading-none">
                  {logCount > 999 ? '999+' : logCount}
                </span>
              )}
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={onConnect}
          disabled={connectLoading}
          className="px-4 py-1.5 bg-bnb text-dark-900 rounded-lg text-sm font-semibold hover:bg-bnb-light transition-colors flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <Activity size={16} /> {connectLoading ? 'Connecting…' : 'Connect'}
        </button>
      )}
    </div>
  )
}
