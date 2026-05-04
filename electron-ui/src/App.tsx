import { useState, useEffect, useCallback, useRef, useMemo, type ChangeEvent } from 'react'
import {
  Eye,
  EyeOff,
  CheckCircle2,
  AlertCircle,
  User,
  KeyRound,
  Wallet,
  Globe,
  Radio,
  Link2,
  Download,
  Upload,
  Trash2,
  Sparkles,
} from 'lucide-react'
import type { MarketState, LogMessage, SSEStatus, GlobalConfig } from './types'
import { api, type LiveStream } from './api'
import Header from './components/Header'
import MarketCard from './components/MarketCard'
import LogOverlay from './components/LogOverlay'
import ConnectDialog from './components/ConnectDialog'
import AddMarketDialog from './components/AddMarketDialog'
import MarketSettingsDialog from './components/MarketSettingsDialog'
import GlobalBatchSettingsDialog from './components/GlobalBatchSettingsDialog'
import ConnectionStatusStrip from './components/ConnectionStatusStrip'
import AutosellPanel from './components/AutosellPanel'
import StatisticsPanel from './components/StatisticsPanel'
import SettingsCategory from './components/SettingsCategory'
import MarketsPagination, { readStoredMarketsPageSize } from './components/MarketsPagination'
import { computeOrdersSummary, shortAddress } from './utils/ordersSummary'
import { safeJsonEqual } from './utils/safeNumber'

if (typeof window !== 'undefined' && window.electronAPI) {
  window.electronAPI.getApiUrl().then(url => {
    api.setBaseUrl(url)
  })
}

type SavedAccountRow = {
  api_key: string
  predict_account_address: string
  privy_wallet_private_key: string
  proxy?: string
}

function SettingInput({ label, type, value, onChange, min, max, step, placeholder, small }: { label: string; type: string; value: string | number; onChange: (v: string) => void; min?: number; max?: number; step?: string; placeholder?: string; small?: boolean }) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} className={"w-full bg-dark-700 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-bnb transition-colors" + (small ? ' px-2 py-1 text-xs' : '')} placeholder={placeholder} min={min} max={max} step={step} />
    </div>
  )
}

function SettingCheckbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="rounded border-dark-600 bg-dark-700 text-bnb focus:ring-bnb" />
      <span className="text-gray-300">{label}</span>
    </label>
  )
}

type GlobalSettingsSectionId = 'parallel' | 'ws' | 'telegram' | 'logging' | 'cooldown' | 'points' | 'markets'

export default function App() {
  const [connected, setConnected] = useState(false)
  const [wsConnected, setWsConnected] = useState(false)
  const [balance, setBalance] = useState(0)
  const [balanceUpdatedAt, setBalanceUpdatedAt] = useState(0)
  const [nickname, setNickname] = useState('')
  const [accountAddress, setAccountAddress] = useState('')
  const [inspectorOrdersCount, setInspectorOrdersCount] = useState(0)
  const [inspectorAutosellOpenCount, setInspectorAutosellOpenCount] = useState(0)
  const [inspectorOrdersUpdatedAt, setInspectorOrdersUpdatedAt] = useState(0)
  const [inspectorEnabled, setInspectorEnabled] = useState(false)
  const [markets, setMarkets] = useState<Record<string, MarketState>>({})
  const [logs, setLogs] = useState<LogMessage[]>([])
  const [showLogs, setShowLogs] = useState(false)
  const [logHighlightTerms, setLogHighlightTerms] = useState<string[] | undefined>(undefined)
  const [showConnect, setShowConnect] = useState(false)
  const [showAddMarket, setShowAddMarket] = useState(false)
  const [showGlobalBatch, setShowGlobalBatch] = useState(false)
  const [placeAllBusy, setPlaceAllBusy] = useState(false)
  const [cancelAllBusy, setCancelAllBusy] = useState(false)
  const [activeTab, setActiveTab] = useState<'markets' | 'settings' | 'autosell' | 'statistics'>('markets')
  const [searchQuery, setSearchQuery] = useState('')
  const [savedCredentials, setSavedCredentials] = useState<{ api_key?: string; predict_account_address?: string; privy_wallet_private_key?: string; proxy?: string } | null>(null)
  const [globalConfig, setGlobalConfig] = useState<GlobalConfig | null>(null)
  const [globalSettingsSaving, setGlobalSettingsSaving] = useState(false)
  const [globalSettingsFeedback, setGlobalSettingsFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const globalSettingsFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [telegramTestLoading, setTelegramTestLoading] = useState(false)
  const [telegramTestMode, setTelegramTestMode] = useState<'summary' | 'balance'>('summary')
  const [telegramTestFeedback, setTelegramTestFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [marketProgress, setMarketProgress] = useState<{ current: number; total: number; loading: boolean } | null>(null)
  const [accounts, setAccounts] = useState<SavedAccountRow[]>([])
  const [accountForm, setAccountForm] = useState<SavedAccountRow>({
    api_key: '',
    predict_account_address: '',
    privy_wallet_private_key: '',
    proxy: '',
  })
  const [accountFieldVisible, setAccountFieldVisible] = useState({ api: false, privy: false, proxy: false })
  const [accountSaveLoading, setAccountSaveLoading] = useState(false)
  const [accountFeedback, setAccountFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [settingsSubTab, setSettingsSubTab] = useState<'global' | 'accounts'>('global')
  const [globalSettingsOpenSection, setGlobalSettingsOpenSection] = useState<GlobalSettingsSectionId | null>(null)
  const [marketsImportData, setMarketsImportData] = useState<unknown | null>(null)
  const [marketsRemoveAllOpen, setMarketsRemoveAllOpen] = useState(false)
  const [marketsOpsBusy, setMarketsOpsBusy] = useState(false)
  const [marketsSectionError, setMarketsSectionError] = useState<string | null>(null)
  const [marketsImportInfo, setMarketsImportInfo] = useState<string | null>(null)
  const [marketSettingsModalId, setMarketSettingsModalId] = useState<string | null>(null)
  const [connectBusy, setConnectBusy] = useState(false)
  const [connectBootstrapError, setConnectBootstrapError] = useState('')
  /** Порядок карточек (порядок появления id в списке), без перестановки при новом стакане */
  const [marketDisplayOrder, setMarketDisplayOrder] = useState<string[]>([])
  const [marketsPage, setMarketsPage] = useState(1)
  const [marketsPageSize, setMarketsPageSize] = useState(() => readStoredMarketsPageSize())
  const esRef = useRef<LiveStream | null>(null)
  /** Форсированная пересоздача подписки (watchdog / visibility): меняем «эпоху» — useEffect пересоздаёт EventSource */
  const [streamEpoch, setStreamEpoch] = useState(0)
  const logTimestampRef = useRef(0)
  /** Накопление патчей state от SSE и сброс таймера — меньше ререндеров при сотнях рынков */
  const statePendingRef = useRef<Record<string, MarketState>>({})
  const stateFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stateDebounceMsRef = useRef(250)
  const lastStatusSigRef = useRef('')

  /** Сброс очереди SSE-патчей — иначе отложенный flush перетирает свежие данные после getAllMarketsState / сохранения настроек */
  const clearPendingMarketSSE = useCallback(() => {
    statePendingRef.current = {}
    if (stateFlushTimerRef.current != null) {
      clearTimeout(stateFlushTimerRef.current)
      stateFlushTimerRef.current = null
    }
  }, [])

  /** После Place/Cancel — сразу тянем состояние с API, иначе «Можно выставить» / карточки ждут SSE (секунды + debounce). */
  const syncMarketsFromApi = useCallback(
    async (singleMarketId?: string) => {
      try {
        clearPendingMarketSSE()
        if (singleMarketId) {
          const raw = await api.getMarketState(singleMarketId)
          if (raw && typeof raw === 'object' && 'error' in raw && (raw as { error?: string }).error) return
          const s = raw as MarketState
          setMarkets(prev => (prev[singleMarketId] ? { ...prev, [singleMarketId]: s } : prev))
        } else {
          setMarkets(await api.getAllMarketsState())
        }
      } catch {
        /* ignore */
      }
    },
    [clearPendingMarketSSE],
  )

  const handleMarketsExport = useCallback(async (includeSettings: boolean) => {
    setMarketsSectionError(null)
    setMarketsImportInfo(null)
    setMarketsOpsBusy(true)
    try {
      const data = await api.getMarketsExport(includeSettings)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      a.href = url
      a.download = includeSettings ? `markets-export-full-${stamp}.json` : `markets-export-ids-${stamp}.json`
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (e) {
      setMarketsSectionError(e instanceof Error ? e.message : 'Ошибка экспорта')
    } finally {
      setMarketsOpsBusy(false)
    }
  }, [])

  const handleMarketsImportFile = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setMarketsSectionError(null)
    setMarketsImportInfo(null)
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result ?? '')) as unknown
        setMarketsImportData(parsed)
      } catch {
        setMarketsSectionError('Файл не похож на корректный JSON')
      }
    }
    reader.onerror = () => setMarketsSectionError('Не удалось прочитать файл')
    reader.readAsText(f)
  }, [])

  const runMarketsImport = useCallback(
    async (applySettings: boolean) => {
      if (marketsImportData == null) return
      if (!connected) {
        setMarketsSectionError('Сначала подключите аккаунт — для импорта нужен API')
        return
      }
      setMarketsSectionError(null)
      setMarketsImportInfo(null)
      setMarketsOpsBusy(true)
      try {
        clearPendingMarketSSE()
        const r = await api.importMarkets(marketsImportData, applySettings)
        if (r.success) {
          setMarketsImportData(null)
          const parts: string[] = []
          if (typeof r.message === 'string' && r.message.trim()) parts.push(r.message.trim())
          if (typeof r.count === 'number' && r.count > 0) parts.push(`Добавлено рынков: ${r.count}`)
          if (typeof r.skipped_existing_count === 'number' && r.skipped_existing_count > 0)
            parts.push(`Уже были загружены (пропуск): ${r.skipped_existing_count}`)
          if (typeof r.updated_existing_settings_count === 'number' && r.updated_existing_settings_count > 0)
            parts.push(`Обновлены настройки: ${r.updated_existing_settings_count}`)
          setMarketsImportInfo(parts.length ? parts.join(' · ') : null)
          await syncMarketsFromApi()
        } else {
          setMarketsSectionError(r.error || 'Импорт не выполнен')
        }
      } catch (e) {
        setMarketsSectionError(e instanceof Error ? e.message : 'Ошибка импорта')
      } finally {
        setMarketsOpsBusy(false)
      }
    },
    [marketsImportData, connected, clearPendingMarketSSE, syncMarketsFromApi],
  )

  const runRemoveAllMarkets = useCallback(
    async (removeSettings: boolean) => {
      setMarketsSectionError(null)
      setMarketsOpsBusy(true)
      try {
        clearPendingMarketSSE()
        const r = await api.removeAllMarkets(removeSettings)
        if (r.success) {
          setMarketsRemoveAllOpen(false)
          await syncMarketsFromApi()
        } else {
          setMarketsSectionError(r.error || 'Не удалось удалить рынки')
        }
      } catch (e) {
        setMarketsSectionError(e instanceof Error ? e.message : 'Ошибка удаления')
      } finally {
        setMarketsOpsBusy(false)
      }
    },
    [clearPendingMarketSSE, syncMarketsFromApi],
  )

  useEffect(() => {
    api.getCredentials().then(creds => {
      if (creds && creds.api_key) setSavedCredentials(creds)
    })
    api.getConfig().then(setGlobalConfig)
  }, [])

  /** Рынки + аккаунт с сервера — общий путь после POST /connect и после F5 (сессия уже на сервере). */
  const fetchMarketsAndAccountAfterConnect = useCallback(async () => {
    try {
      clearPendingMarketSSE()
      const states = await api.getAllMarketsState()
      setMarkets(states)
    } catch {
      /* ignore */
    }
    try {
      const info = await api.getAccountInfo()
      if (!info.error) {
        if (info.nickname?.trim()) setNickname(info.nickname.trim())
        if (info.address) setAccountAddress(info.address)
        if (typeof info.balance === 'number' && Number.isFinite(info.balance)) setBalance(info.balance)
        if (typeof info.balance_updated_at === 'number') setBalanceUpdatedAt(info.balance_updated_at)
      }
    } catch {
      /* ignore */
    }
    try {
      const b = await api.getBalance()
      if (typeof b.balance === 'number' && Number.isFinite(b.balance)) setBalance(b.balance)
      if (typeof b.updated_at === 'number') setBalanceUpdatedAt(b.updated_at)
    } catch {
      /* ignore */
    }
  }, [clearPendingMarketSSE])

  /** После перезагрузки окна (F5): сервер всё ещё connected — подтягиваем UI без повторного Connect. */
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const st = await api.getAuthStatus()
        if (cancelled || !st.connected) return
        setConnected(true)
        setShowConnect(false)
        setConnectBootstrapError('')
        await fetchMarketsAndAccountAfterConnect()
      } catch {
        /* сервер ещё не поднят или сеть */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fetchMarketsAndAccountAfterConnect])

  useEffect(() => {
    return () => {
      if (globalSettingsFeedbackTimerRef.current) {
        clearTimeout(globalSettingsFeedbackTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (activeTab === 'settings') {
      api.getConfig().then(setGlobalConfig)
      api.getAccounts().then(data => setAccounts(data.accounts || []))
    }
  }, [activeTab])

  const savedAccountSyncKey = accounts[0]
    ? `${accounts[0].predict_account_address}\0${accounts[0].api_key}\0${accounts[0].privy_wallet_private_key}\0${accounts[0].proxy ?? ''}`
    : ''

  useEffect(() => {
    if (activeTab !== 'settings' || settingsSubTab !== 'accounts') return
    const row = accounts[0]
    if (!row) {
      setAccountForm({ api_key: '', predict_account_address: '', privy_wallet_private_key: '', proxy: '' })
      return
    }
    setAccountForm({
      api_key: row.api_key,
      predict_account_address: row.predict_account_address,
      privy_wallet_private_key: row.privy_wallet_private_key,
      proxy: row.proxy || '',
    })
  }, [activeTab, settingsSubTab, savedAccountSyncKey])

  useEffect(() => {
    if (!connected) {
      const interval = setInterval(async () => {
        const progress = await api.getMarketLoadingProgress()
        if (progress && progress.loading) {
          setMarketProgress(progress)
        } else if (progress && !progress.loading && progress.total > 0) {
          setMarketProgress(progress)
          setTimeout(() => setMarketProgress(null), 2000)
        } else {
          setMarketProgress(null)
        }
      }, 500)
      return () => clearInterval(interval)
    } else {
      setMarketProgress(null)
    }
  }, [connected])

  useEffect(() => {
    const n = Object.keys(markets).length
    stateDebounceMsRef.current = n > 200 ? 380 : n > 80 ? 220 : n > 30 ? 160 : 90
  }, [markets])

  useEffect(() => {
    setMarketsPage(1)
  }, [searchQuery])

  useEffect(() => {
    const ids = Object.keys(markets)
    setMarketDisplayOrder(prev => {
      const have = new Set(ids)
      const kept = prev.filter(id => have.has(id))
      const seen = new Set(kept)
      for (const id of ids) {
        if (!seen.has(id)) {
          kept.push(id)
          seen.add(id)
        }
      }
      return kept
    })
  }, [markets])

  const mergeWithNewerSettings = useCallback((old: MarketState, s: MarketState): MarketState => {
    const ou = old.settings_updated_at ?? 0
    const su = s.settings_updated_at ?? 0
    if (ou > su && old.settings != null) {
      return { ...s, settings: old.settings, settings_updated_at: old.settings_updated_at }
    }
    if (ou > 0 && ou === su && old.settings != null && s.settings != null) {
      if (JSON.stringify(old.settings) !== JSON.stringify(s.settings)) {
        return s
      }
    }
    return s
  }, [])

  const flushPendingMarketState = useCallback(() => {
    stateFlushTimerRef.current = null
    const batch = statePendingRef.current
    const ids = Object.keys(batch)
    if (ids.length === 0) return
    statePendingRef.current = {}
    setMarkets(prev => {
      let changed = false
      const next = { ...prev }
      for (const id of ids) {
        const raw = batch[id]
        const old = next[id]
        if (!old) {
          next[id] = raw
          changed = true
          continue
        }
        const s = mergeWithNewerSettings(old, raw)
        const ns = s.settings_updated_at ?? 0
        const osu = old.settings_updated_at ?? 0
        if (ns > osu) {
          next[id] = s
          changed = true
          continue
        }
        const ot = old.update_time ?? 0
        const st = s.update_time ?? 0
        if (st < ot) {
          continue
        }
        if (st > ot) {
          next[id] = s
          changed = true
          continue
        }
        if (old.mid_price !== s.mid_price) {
          next[id] = s
          changed = true
          continue
        }
        if (!safeJsonEqual(old.order_info, s.order_info)) {
          next[id] = s
          changed = true
          continue
        }
        if (!safeJsonEqual(old.settings, s.settings)) {
          next[id] = s
          changed = true
          continue
        }
        if (!safeJsonEqual(old.active_orders, s.active_orders)) {
          next[id] = s
          changed = true
          continue
        }
        if (old.liquidity_session_armed !== s.liquidity_session_armed) {
          next[id] = s
          changed = true
          continue
        }
        if (old.liquidity_volatile_in_cooldown !== s.liquidity_volatile_in_cooldown) {
          next[id] = s
          changed = true
          continue
        }
        if (old.liquidity_volatile_cooldown_until !== s.liquidity_volatile_cooldown_until) {
          next[id] = s
          changed = true
          continue
        }
        if (old.collateral_cooldown !== s.collateral_cooldown) {
          next[id] = s
          changed = true
          continue
        }
        if (old.collateral_cooldown_until !== s.collateral_cooldown_until) {
          next[id] = s
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [mergeWithNewerSettings])

  const handleStateUpdate = useCallback(
    (states: Record<string, MarketState>) => {
      Object.assign(statePendingRef.current, states)
      if (stateFlushTimerRef.current != null) return
      stateFlushTimerRef.current = setTimeout(flushPendingMarketState, stateDebounceMsRef.current)
    },
    [flushPendingMarketState],
  )

  const handleStatusUpdate = useCallback((status: SSEStatus) => {
    const sig = [
      status.connected,
      status.ws_connected,
      status.balance,
      status.balance_updated_at ?? 0,
      status.inspector_orders_count,
      status.inspector_autosell_open_count ?? 0,
      status.inspector_orders_updated_at ?? 0,
      status.inspector_enabled,
      status.ws_last_update,
      JSON.stringify(status.market_loading_progress ?? null),
    ].join('|')
    if (sig === lastStatusSigRef.current) return
    lastStatusSigRef.current = sig
    setConnected(status.connected)
    setWsConnected(status.ws_connected)
    setBalance(typeof status.balance === 'number' && Number.isFinite(status.balance) ? status.balance : 0)
    if (typeof status.balance_updated_at === 'number') {
      setBalanceUpdatedAt(status.balance_updated_at)
    }
    setInspectorOrdersCount(status.inspector_orders_count)
    setInspectorAutosellOpenCount(
      typeof status.inspector_autosell_open_count === 'number' ? status.inspector_autosell_open_count : 0,
    )
    if (typeof status.inspector_orders_updated_at === 'number') {
      setInspectorOrdersUpdatedAt(status.inspector_orders_updated_at)
    }
    if (typeof status.inspector_enabled === 'boolean') {
      setInspectorEnabled(status.inspector_enabled)
    }
    if (status.market_loading_progress) {
      setMarketProgress(status.market_loading_progress)
    }
  }, [])

  const handleLog = useCallback((log: LogMessage) => {
    const line = `[${log.level}] ${log.message}`
    if (typeof globalThis.console !== 'undefined') {
      if (log.level === 'error') globalThis.console.error(line)
      else if (log.level === 'warning') globalThis.console.warn(line)
      else globalThis.console.log(line)
    }
    setLogs(prev => [...prev.slice(-2000), log])
    logTimestampRef.current = Math.max(logTimestampRef.current, log.timestamp)
  }, [])

  const handleClearLogs = useCallback(async () => {
    try {
      await api.clearLogs()
    } catch {
      /* сеть / сервер — всё равно чистим UI */
    }
    setLogs([])
    logTimestampRef.current = Date.now() / 1000
  }, [])

  useEffect(() => {
    if (!connected) return
    esRef.current = api.subscribeEvents(handleLog, handleStateUpdate, handleStatusUpdate)
    return () => {
      if (stateFlushTimerRef.current) {
        clearTimeout(stateFlushTimerRef.current)
        stateFlushTimerRef.current = null
      }
      statePendingRef.current = {}
      esRef.current?.close()
      esRef.current = null
    }
  }, [connected, streamEpoch, handleLog, handleStateUpdate, handleStatusUpdate])

  /**
   * Серый экран после долгого простоя = потерянный SSE + отсутствие перерисовки.
   * Watchdog: если подписка в CLOSED или молчит больше 30 сек — пересоздаём её и тянем состояние.
   */
  useEffect(() => {
    if (!connected) return
    const SILENCE_LIMIT_MS = 30_000
    const interval = setInterval(() => {
      const es = esRef.current
      if (!es) return
      const closed = es.getReadyState() === 2
      const silentTooLong = es.getMsSinceLastEvent() > SILENCE_LIMIT_MS
      if (closed || silentTooLong) {
        void syncMarketsFromApi()
        setStreamEpoch(v => v + 1)
      }
    }, 5_000)
    return () => clearInterval(interval)
  }, [connected, syncMarketsFromApi])

  /**
   * После возврата к окну (visibilitychange/focus/online) немедленно актуализируем данные —
   * иначе UI остаётся с «замороженным» снимком из прошлой сессии, пока не придёт следующий SSE-батч.
   */
  useEffect(() => {
    if (!connected) return
    const onWake = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void syncMarketsFromApi()
      const es = esRef.current
      if (!es || es.getReadyState() !== 1) {
        setStreamEpoch(v => v + 1)
      }
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    window.addEventListener('online', onWake)
    return () => {
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
      window.removeEventListener('online', onWake)
    }
  }, [connected, syncMarketsFromApi])

  const handleConnect = useCallback(async (data: { api_key: string; predict_account_address: string; privy_wallet_private_key: string; proxy?: string }) => {
    const res = await api.connect(data)
    if (res.success) {
      setConnected(true)
      setBalance(
        typeof res.account_info?.balance === 'number' && Number.isFinite(res.account_info.balance)
          ? res.account_info.balance
          : 0,
      )
      setNickname((res.account_info?.nickname ?? '').trim())
      setAccountAddress(res.account_info?.address ?? '')
      setShowConnect(false)
      setConnectBootstrapError('')
      setMarketProgress({ current: 0, total: 0, loading: true })
      await fetchMarketsAndAccountAfterConnect()
    }
    return res
  }, [fetchMarketsAndAccountAfterConnect])

  /** Сначала accounts.txt, иначе credentials.json — как при ручном Connect */
  const resolveSavedLogin = useCallback(async (): Promise<{ api_key: string; predict_account_address: string; privy_wallet_private_key: string; proxy?: string } | null> => {
    try {
      const data = await api.getAccounts()
      if (data.accounts && data.accounts.length > 0) {
        const acc = data.accounts[0]
        return {
          api_key: acc.api_key,
          predict_account_address: acc.predict_account_address,
          privy_wallet_private_key: acc.privy_wallet_private_key,
          proxy: acc.proxy,
        }
      }
    } catch { /* ignore */ }
    try {
      const creds = await api.getCredentials()
      if (creds?.api_key && creds?.predict_account_address && creds?.privy_wallet_private_key) {
        return {
          api_key: creds.api_key,
          predict_account_address: creds.predict_account_address,
          privy_wallet_private_key: creds.privy_wallet_private_key,
          proxy: creds.proxy || undefined,
        }
      }
    } catch { /* ignore */ }
    return null
  }, [])

  const handleConnectClick = useCallback(async () => {
    if (connected || connectBusy) return
    setConnectBusy(true)
    setConnectBootstrapError('')
    try {
      const login = await resolveSavedLogin()
      if (!login) {
        setShowConnect(true)
        return
      }
      const res = await handleConnect(login)
      if (!res.success) {
        setConnectBootstrapError(res.error || 'Connection failed')
        setShowConnect(true)
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Connection failed'
      setConnectBootstrapError(msg)
      setShowConnect(true)
    } finally {
      setConnectBusy(false)
    }
  }, [connected, connectBusy, resolveSavedLogin, handleConnect])

  const handleToggleInspector = async () => {
    if (inspectorEnabled) {
      await api.disableInspector()
      setInspectorEnabled(false)
    } else {
      await api.enableInspector()
      setInspectorEnabled(true)
    }
  }

  const handleCancelAll = async () => {
    setCancelAllBusy(true)
    try {
      await api.cancelAllOrders()
      await syncMarketsFromApi()
    } finally {
      setCancelAllBusy(false)
    }
  }
  const handlePlaceAll = async () => {
    setPlaceAllBusy(true)
    try {
      await api.placeAllOrders()
      await syncMarketsFromApi()
    } finally {
      setPlaceAllBusy(false)
    }
  }

  const handleRemoveMarket = async (marketId: string) => {
    await api.removeMarket(marketId)
    setMarkets(prev => { const next = { ...prev }; delete next[marketId]; return next })
  }

  const handleSaveGlobalSettings = async () => {
    if (!globalConfig) return
    if (globalSettingsFeedbackTimerRef.current) {
      clearTimeout(globalSettingsFeedbackTimerRef.current)
      globalSettingsFeedbackTimerRef.current = null
    }
    setGlobalSettingsFeedback(null)
    setGlobalSettingsSaving(true)
    try {
      const r = await api.updateConfig(globalConfig)
      if (r.success) {
        setGlobalSettingsFeedback({ kind: 'ok', text: 'Настройки сохранены и применены' })
        globalSettingsFeedbackTimerRef.current = setTimeout(() => {
          setGlobalSettingsFeedback(null)
          globalSettingsFeedbackTimerRef.current = null
        }, 5000)
      } else {
        setGlobalSettingsFeedback({ kind: 'err', text: 'Сервер не сохранил настройки' })
      }
    } catch {
      setGlobalSettingsFeedback({ kind: 'err', text: 'Ошибка запроса — проверьте, что сервер запущен' })
    } finally {
      setGlobalSettingsSaving(false)
    }
  }

  const handleTelegramTest = async () => {
    if (!globalConfig) return
    setTelegramTestLoading(true)
    setTelegramTestFeedback(null)
    try {
      const r = await api.telegramSendTest({
        mode: telegramTestMode,
        telegram_token: globalConfig.telegram_token,
        telegram_chat_id: globalConfig.telegram_chat_id,
      })
      if (r.success) {
        setTelegramTestFeedback({ kind: 'ok', text: 'Тестовое сообщение отправлено в Telegram' })
      } else {
        setTelegramTestFeedback({ kind: 'err', text: r.error || 'Не удалось отправить' })
      }
    } catch {
      setTelegramTestFeedback({ kind: 'err', text: 'Ошибка запроса — проверьте, что сервер запущен' })
    } finally {
      setTelegramTestLoading(false)
    }
  }

  const handleSaveAccountSettings = async () => {
    if (!accounts[0]) return
    setAccountFeedback(null)
    const f = accountForm
    const apiKey = f.api_key.trim()
    const addr = f.predict_account_address.trim()
    const pk = f.privy_wallet_private_key.trim()
    if (!apiKey || !addr || !pk) {
      setAccountFeedback({ kind: 'err', text: 'Заполните API Key, адрес Predict и приватный ключ кошелька.' })
      return
    }
    if (!addr.startsWith('0x')) {
      setAccountFeedback({ kind: 'err', text: 'Адрес аккаунта должен начинаться с 0x.' })
      return
    }
    setAccountSaveLoading(true)
    try {
      await api.updateAccount(0, {
        api_key: apiKey,
        predict_account_address: addr,
        privy_wallet_private_key: pk,
        proxy: f.proxy?.trim() || undefined,
      })
      const data = await api.getAccounts()
      setAccounts(data.accounts || [])
      setAccountFeedback({ kind: 'ok', text: 'Сохранено. Данные записаны в хранилище аккаунта на сервере.' })
    } catch {
      setAccountFeedback({ kind: 'err', text: 'Не удалось сохранить — проверьте, что backend запущен.' })
    } finally {
      setAccountSaveLoading(false)
    }
  }

  const handleDeleteAccount = async () => {
    if (!accounts[0]) return
    setAccountFeedback(null)
    await api.deleteAccount(0)
    setAccounts(prev => prev.filter((_, i) => i !== 0))
  }

  const filteredMarkets = Object.values(markets).filter(m => {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return m.title?.toLowerCase().includes(q) || m.question?.toLowerCase().includes(q) || m.slug?.toLowerCase().includes(q) || m.market_id?.toLowerCase().includes(q)
  })

  const totalMarketCount = Object.keys(markets).length

  const accountLabel = useMemo(() => {
    const n = nickname.trim()
    if (n) return n
    if (accountAddress) return shortAddress(accountAddress)
    return ''
  }, [nickname, accountAddress])

  const ordersSummary = useMemo(() => computeOrdersSummary(markets), [markets])

  const sortModeIndex = globalConfig?.sort_mode ?? 0

  const sortedMarkets = useMemo(() => {
    const list = [...filteredMarkets]
    if (sortModeIndex === 0) {
      const idx = (id: string) => {
        const i = marketDisplayOrder.indexOf(id)
        return i === -1 ? 999_999 : i
      }
      return list.sort((a, b) => idx(a.market_id) - idx(b.market_id))
    }
    if (sortModeIndex === 1) {
      const idKey = (m: MarketState) => {
        const mid = m.market_id || ''
        if (/^\d+$/.test(mid)) return [0, parseInt(mid, 10)] as [number, number | string]
        return [1, mid.toLowerCase()] as [number, number | string]
      }
      return list.sort((a, b) => {
        const ka = idKey(a), kb = idKey(b)
        if (ka[0] !== kb[0]) return ka[0] - kb[0]
        if (ka[1] < kb[1]) return -1
        if (ka[1] > kb[1]) return 1
        return 0
      })
    }
    if (sortModeIndex === 2) {
      return list.sort((a, b) => {
        const ta = (a.title || a.question || a.market_id || '').toLowerCase()
        const tb = (b.title || b.question || b.market_id || '').toLowerCase()
        return ta.localeCompare(tb)
      })
    }
    return list
  }, [filteredMarkets, sortModeIndex, marketDisplayOrder])

  const totalMarketListPages = Math.max(1, Math.ceil(sortedMarkets.length / marketsPageSize))


  useEffect(() => {
    setMarketsPage(p => Math.min(Math.max(1, p), totalMarketListPages))
  }, [totalMarketListPages])

  const pagedMarkets = useMemo(() => {
    const page = Math.min(Math.max(1, marketsPage), totalMarketListPages)
    const start = (page - 1) * marketsPageSize
    return sortedMarkets.slice(start, start + marketsPageSize)
  }, [sortedMarkets, marketsPage, marketsPageSize, totalMarketListPages])

  const handleMarketsPageSizeChange = useCallback((size: number) => {
    try {
      localStorage.setItem('pf_markets_page_size', String(size))
    } catch { /* ignore */ }
    setMarketsPageSize(size)
    setMarketsPage(1)
  }, [])

  const sortButtonLabel = sortModeIndex === 0 ? 'Как в списке' : sortModeIndex === 1 ? 'По ID' : 'По названию'

  const cycleSortMode = useCallback(async () => {
    if (!globalConfig) return
    const next = (globalConfig.sort_mode + 1) % 3
    const updated = { ...globalConfig, sort_mode: next }
    setGlobalConfig(updated)
    await api.updateConfig({ sort_mode: next })
  }, [globalConfig])

  const updateGlobal = (key: string, value: any) => setGlobalConfig(prev => prev ? { ...prev, [key]: value } : prev)

  const progressPercent = marketProgress && marketProgress.total > 0
    ? Math.round((marketProgress.current / marketProgress.total) * 100)
    : 0

  return (
    <div className="flex flex-col h-screen bg-dark-900 text-gray-100">
      <Header
        connected={connected} wsConnected={wsConnected} balance={balance}
        balanceUpdatedAt={balanceUpdatedAt}
        accountLabel={accountLabel}
        onConnect={handleConnectClick}
        connectLoading={connectBusy}
        onOpenLogs={() => setShowLogs(true)}
        logCount={logs.length}
      />

      {connected && (
        <ConnectionStatusStrip
          totalMarkets={totalMarketCount}
          filteredCount={filteredMarkets.length}
          searchActive={!!searchQuery.trim()}
          prelim={ordersSummary.prelim}
          placed={ordersSummary.placed}
          apiOrdersCount={inspectorOrdersCount}
          apiAutosellOpenCount={inspectorAutosellOpenCount}
          apiUpdatedAt={inspectorOrdersUpdatedAt}
          inspectorEnabled={inspectorEnabled}
          onToggleInspector={handleToggleInspector}
          rightSlot={
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                disabled={placeAllBusy || totalMarketCount === 0}
                onClick={handlePlaceAll}
                className="px-3 py-1.5 bg-dark-700 border border-dark-600 rounded-lg text-xs sm:text-sm hover:border-bnb transition-colors disabled:opacity-50 whitespace-nowrap"
                title="Выставить лимитки на всех рынках"
              >
                {placeAllBusy ? 'Выставление…' : 'Выставить'}
              </button>
              <button
                type="button"
                disabled={cancelAllBusy || totalMarketCount === 0}
                onClick={handleCancelAll}
                className="px-3 py-1.5 bg-dark-700 border border-dark-600 rounded-lg text-xs sm:text-sm hover:border-danger/60 transition-colors disabled:opacity-50 whitespace-nowrap"
                title="Снять ордера на всех рынках"
              >
                {cancelAllBusy ? 'Снятие…' : 'Убрать'}
              </button>
              <button
                type="button"
                onClick={() => setShowGlobalBatch(true)}
                className="px-3 py-1.5 bg-dark-700 border border-bnb/40 rounded-lg text-xs sm:text-sm text-bnb hover:bg-bnb/10 transition-colors whitespace-nowrap"
                title="Общие настройки для всех рынков"
              >
                Общие
              </button>
            </div>
          }
        />
      )}

      {marketProgress && marketProgress.loading && (
        <div className="px-4 py-2 bg-dark-800 border-b border-dark-600">
          <div className="flex items-center gap-3 max-w-2xl mx-auto">
            <span className="text-xs text-gray-400 whitespace-nowrap">
              Loading markets: {marketProgress.current}/{marketProgress.total}
            </span>
            <div className="flex-1 h-2 bg-dark-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-bnb rounded-full transition-all duration-300 ease-out"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <span className="text-xs text-bnb font-medium whitespace-nowrap">
              {progressPercent}%
            </span>
          </div>
        </div>
      )}

      <div className="flex border-b border-dark-600 bg-dark-800">
        <button
          onClick={() => setActiveTab('markets')}
          className={"px-6 py-2.5 text-sm font-medium transition-colors border-b-2 " + (activeTab === 'markets' ? 'border-bnb text-bnb' : 'border-transparent text-gray-500 hover:text-gray-300')}
        >
          Markets
        </button>
        <button
          onClick={() => setActiveTab('settings')}
          className={"px-6 py-2.5 text-sm font-medium transition-colors border-b-2 " + (activeTab === 'settings' ? 'border-bnb text-bnb' : 'border-transparent text-gray-500 hover:text-gray-300')}
        >
          Settings
        </button>
        <button
          onClick={() => setActiveTab('autosell')}
          className={"px-6 py-2.5 text-sm font-medium transition-colors border-b-2 " + (activeTab === 'autosell' ? 'border-bnb text-bnb' : 'border-transparent text-gray-500 hover:text-gray-300')}
        >
          Auto-sell
        </button>
        <button
          onClick={() => setActiveTab('statistics')}
          className={"px-6 py-2.5 text-sm font-medium transition-colors border-b-2 " + (activeTab === 'statistics' ? 'border-bnb text-bnb' : 'border-transparent text-gray-500 hover:text-gray-300')}
        >
          Статистика
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'markets' && (
          <div>
            <div className="flex flex-wrap items-center gap-2 sm:gap-3 px-4 py-2 bg-dark-800 border-b border-dark-600">
              <input type="text" placeholder="Search by title, question, slug or ID..." value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="flex-1 min-w-[160px] bg-dark-700 border border-dark-600 rounded-lg px-3 py-1.5 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-bnb transition-colors" />
              <button type="button" onClick={() => cycleSortMode()}
                className="px-3 py-1.5 bg-dark-700 border border-dark-600 rounded-lg text-sm hover:border-bnb transition-colors">
                Сортировка: {sortButtonLabel}
              </button>
              <button onClick={() => setShowAddMarket(true)}
                className="px-3 py-1.5 bg-bnb text-dark-900 rounded-lg text-sm font-medium hover:bg-bnb-light transition-colors">
                + Add Market
              </button>
            </div>
            {totalMarketCount > 0 && (
              <MarketsPagination
                totalItems={sortedMarkets.length}
                page={marketsPage}
                pageSize={marketsPageSize}
                onPageChange={setMarketsPage}
                onPageSizeChange={handleMarketsPageSizeChange}
              />
            )}
            <div className="p-4">
              {sortedMarkets.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-gray-500">
                  <p className="text-lg mb-2">No markets loaded</p>
                  <p className="text-sm">Click &quot;Add Market&quot; to get started</p>
                </div>
              ) : (
                <div className="flex flex-wrap gap-4 justify-center">
                  {pagedMarkets.map(m => (
                    <MarketCard
                      key={m.market_id}
                      state={m}
                      onRemove={() => handleRemoveMarket(m.market_id)}
                      onSettings={() => setMarketSettingsModalId(m.market_id)}
                      onOrdersChanged={() => { void syncMarketsFromApi(m.market_id) }}
                      onOpenLogsWithHighlight={terms => {
                        setLogHighlightTerms(terms)
                        setShowLogs(true)
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="p-6 max-w-3xl mx-auto">
            <div className="flex gap-2 mb-6">
              <button onClick={() => setSettingsSubTab('global')} className={"px-4 py-2 rounded-lg text-sm font-medium transition-colors " + (settingsSubTab === 'global' ? 'bg-bnb text-dark-900' : 'bg-dark-800 text-gray-400 hover:text-gray-200 border border-dark-600')}>Global</button>
              <button onClick={() => setSettingsSubTab('accounts')} className={"px-4 py-2 rounded-lg text-sm font-medium transition-colors " + (settingsSubTab === 'accounts' ? 'bg-bnb text-dark-900' : 'bg-dark-800 text-gray-400 hover:text-gray-200 border border-dark-600')}>Аккаунт</button>
            </div>

            {settingsSubTab === 'global' && globalConfig && (
              <div className="space-y-3">
                <SettingsCategory
                  title="Потоки"
                  subtitle="Одновременные Place/Cancel All и загрузка рынков"
                  open={globalSettingsOpenSection === 'parallel'}
                  onToggle={() =>
                    setGlobalSettingsOpenSection(s => (s === 'parallel' ? null : 'parallel'))
                  }
                  iconSlot={
                    <div className="w-8 h-8 rounded-lg bg-cyan-500/20 flex items-center justify-center">
                      <svg className="w-4 h-4 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v7a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v7a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 17a1 1 0 011-1h4a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1v-2zM14 17a1 1 0 011-1h4a1 1 0 011 1v2a1 1 0 01-1 1h-4a1 1 0 01-1-1v-2z" />
                      </svg>
                    </div>
                  }
                >
                  <p className="text-xs text-gray-500 pt-1">Лимиты одновременных операций на сервере.</p>
                  <div className="grid grid-cols-2 gap-3">
                    <SettingInput
                      label="Place All / Cancel All (рынков одновременно)"
                      type="number"
                      value={globalConfig.orders_all_max_concurrent ?? 20}
                      onChange={v => updateGlobal('orders_all_max_concurrent', Math.min(100, Math.max(1, parseInt(v, 10) || 1)))}
                      min={1}
                      max={100}
                    />
                    <SettingInput
                      label="Загрузка рынков (парсинг API одновременно)"
                      type="number"
                      value={globalConfig.market_load_max_concurrent ?? 10}
                      onChange={v => updateGlobal('market_load_max_concurrent', Math.min(100, Math.max(1, parseInt(v, 10) || 1)))}
                      min={1}
                      max={100}
                    />
                  </div>
                </SettingsCategory>

                <SettingsCategory
                  title="WebSocket Pool"
                  subtitle="Размер пула, dedupe, stagger, ротация слотов"
                  open={globalSettingsOpenSection === 'ws'}
                  onToggle={() => setGlobalSettingsOpenSection(s => (s === 'ws' ? null : 'ws'))}
                  iconSlot={
                    <div className="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center">
                      <svg className="w-4 h-4 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                    </div>
                  }
                >
                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <SettingInput label="Pool Size" type="number" value={globalConfig.websocket_pool_size} onChange={v => updateGlobal('websocket_pool_size', parseInt(v))} min={1} max={32} />
                    <SettingInput label="Dedupe (sec)" type="number" step="0.01" value={globalConfig.websocket_dedupe_identical_sec} onChange={v => updateGlobal('websocket_dedupe_identical_sec', parseFloat(v))} min={0} max={0.5} />
                    <SettingInput label="Stagger (ms)" type="number" value={globalConfig.websocket_connect_stagger_ms} onChange={v => updateGlobal('websocket_connect_stagger_ms', parseInt(v))} min={0} max={2000} />
                    <SettingInput label="Rebalance (sec)" type="number" value={globalConfig.websocket_slow_slot_rebalance_sec} onChange={v => updateGlobal('websocket_slow_slot_rebalance_sec', parseInt(v))} min={0} max={600} />
                    <SettingInput label="Min Spread (rot.)" type="number" value={globalConfig.websocket_slow_slot_min_spread} onChange={v => updateGlobal('websocket_slow_slot_min_spread', parseInt(v))} min={1} max={500} />
                    <SettingInput label="Min Top (rot.)" type="number" value={globalConfig.websocket_slow_slot_min_top} onChange={v => updateGlobal('websocket_slow_slot_min_top', parseInt(v))} min={1} max={10000} />
                    <SettingInput label="Slow slots / rotate" type="number" value={globalConfig.websocket_slow_slots_per_rebalance} onChange={v => updateGlobal('websocket_slow_slots_per_rebalance', parseInt(v))} min={1} max={16} />
                    <SettingInput label="Dedupe depth (lvls)" type="number" value={globalConfig.websocket_dedupe_depth_levels} onChange={v => updateGlobal('websocket_dedupe_depth_levels', parseInt(v))} min={1} max={64} />
                    <div className="col-span-2 space-y-1">
                      <SettingCheckbox label="Pool Verbose" checked={globalConfig.websocket_pool_verbose} onChange={v => updateGlobal('websocket_pool_verbose', v)} />
                      <p className="text-[11px] text-gray-500 leading-snug pl-0.5">
                        Slow slots / rotate — сколько самых медленных слотов пересоздавать за один цикл ребаланса (анти-«молчащий вебсокет»). Dedupe depth — на сколько уровней с каждой стороны смотрит фингерпринт дедупа: больше → точнее ранг скорости и не теряются обновления глубины. Pool Verbose — при pool size &gt; 1 пишет в лог сервера: какие слоты чаще выигрывают стакан и сколько дублей отрезано.
                      </p>
                    </div>
                    <div className="col-span-2 space-y-1">
                      <SettingCheckbox label="Realtime Log" checked={globalConfig.websocket_pool_realtime_log} onChange={v => updateGlobal('websocket_pool_realtime_log', v)} />
                      <p className="text-[11px] text-gray-500 leading-snug pl-0.5">
                        Real-time лог пула в консоль сервера. Префикс [ws-rt]. Пишет каждое событие сразу: CONNECT/DISCONNECT слотов, FORWARD каждого принятого стакана (slot, mid, top, кол-во уровней), DUP-DROP отрезанных дубликатов с возрастом, ROT-PLAN/ROT-START/ROT-DONE при ротации, POOL-START/STOP, SUBSCRIBE/UNSUBSCR. Внимание: при активных рынках это может быть много строк — для отладки оставляем включённым, в спокойной работе можно выключить.
                      </p>
                    </div>
                  </div>
                </SettingsCategory>

                <SettingsCategory
                  title="Telegram"
                  subtitle="Уведомления, токен, чат, тестовая отправка"
                  open={globalSettingsOpenSection === 'telegram'}
                  onToggle={() => setGlobalSettingsOpenSection(s => (s === 'telegram' ? null : 'telegram'))}
                  iconSlot={
                    <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center">
                      <svg className="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                      </svg>
                    </div>
                  }
                >
                  <div className="space-y-3 pt-1">
                    <SettingCheckbox label="Enable notifications" checked={globalConfig.telegram_enabled} onChange={v => updateGlobal('telegram_enabled', v)} />
                    <input type="text" value={globalConfig.telegram_token} onChange={e => updateGlobal('telegram_token', e.target.value)} className="w-full bg-dark-700 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-bnb transition-colors" placeholder="Telegram Bot Token" />
                    <input type="text" value={globalConfig.telegram_chat_id} onChange={e => updateGlobal('telegram_chat_id', e.target.value)} className="w-full bg-dark-700 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-bnb transition-colors" placeholder="Chat ID" />
                    <SettingInput label="Status report interval (min)" type="number" value={globalConfig.telegram_status_interval_minutes} onChange={v => updateGlobal('telegram_status_interval_minutes', parseInt(v))} min={1} />
                    <div className="mt-4 pt-4 border-t border-dark-600/60 space-y-4">
                      <div className="text-xs font-semibold uppercase tracking-wide text-bnb/90">Тестовое уведомление</div>
                      <div className="flex flex-col gap-3 text-sm text-gray-300">
                        <label className="flex items-center gap-3 cursor-pointer py-1">
                          <input
                            type="radio"
                            name="tg-test-mode"
                            checked={telegramTestMode === 'summary'}
                            onChange={() => setTelegramTestMode('summary')}
                            className="text-bnb focus:ring-bnb shrink-0"
                          />
                          <span>Тест: <span className="text-gray-200">сводка</span></span>
                        </label>
                        <label className="flex items-center gap-3 cursor-pointer py-1">
                          <input
                            type="radio"
                            name="tg-test-mode"
                            checked={telegramTestMode === 'balance'}
                            onChange={() => setTelegramTestMode('balance')}
                            className="text-bnb focus:ring-bnb shrink-0"
                          />
                          <span>Тест: <span className="text-gray-200">баланс</span></span>
                        </label>
                      </div>
                      <button
                        type="button"
                        onClick={handleTelegramTest}
                        disabled={telegramTestLoading}
                        className="w-full py-3 rounded-lg text-sm font-medium border border-dark-600 bg-dark-700 text-gray-200 hover:bg-dark-600 hover:border-bnb/40 transition-colors disabled:opacity-50"
                      >
                        {telegramTestLoading ? 'Отправка…' : 'Отправить тестовое уведомление'}
                      </button>
                      {telegramTestFeedback ? (
                        <p className={`text-xs ${telegramTestFeedback.kind === 'err' ? 'text-amber-400' : 'text-emerald-400/90'}`}>
                          {telegramTestFeedback.text}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </SettingsCategory>

                <SettingsCategory
                  title="Logging"
                  subtitle="Логи софта, стакана, ордеров и консоль"
                  open={globalSettingsOpenSection === 'logging'}
                  onToggle={() => setGlobalSettingsOpenSection(s => (s === 'logging' ? null : 'logging'))}
                  iconSlot={
                    <div className="w-8 h-8 rounded-lg bg-green-500/20 flex items-center justify-center">
                      <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </div>
                  }
                >
                  <div className="space-y-2 pt-1">
                    <SettingCheckbox label="Software logs" checked={globalConfig.log_software} onChange={v => updateGlobal('log_software', v)} />
                    <SettingCheckbox label="Orderbook logs" checked={globalConfig.log_orderbook} onChange={v => updateGlobal('log_orderbook', v)} />
                    <SettingCheckbox label="Order logs" checked={globalConfig.log_orders} onChange={v => updateGlobal('log_orders', v)} />
                    <SettingCheckbox
                      label="Console diagnostics (подробные [diag] в консоли main.py)"
                      checked={globalConfig.console_diagnostics ?? true}
                      onChange={v => updateGlobal('console_diagnostics', v)}
                    />
                  </div>
                </SettingsCategory>

                <SettingsCategory
                  title="Cooldown"
                  subtitle="Залог, опрос баланса, интервал инспектора"
                  open={globalSettingsOpenSection === 'cooldown'}
                  onToggle={() => setGlobalSettingsOpenSection(s => (s === 'cooldown' ? null : 'cooldown'))}
                  iconSlot={
                    <div className="w-8 h-8 rounded-lg bg-red-500/20 flex items-center justify-center">
                      <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                  }
                >
                  <div className="space-y-3 pt-1">
                    <SettingInput
                      label="Insufficient collateral cooldown (sec)"
                      type="number"
                      value={globalConfig.insufficient_collateral_cooldown_sec}
                      onChange={v => updateGlobal('insufficient_collateral_cooldown_sec', parseInt(v))}
                      min={60}
                      max={86400}
                    />
                    <p className="text-xs text-gray-500">Пауза после срабатывания «недостаточно залога» перед следующей попыткой выставления.</p>
                    <SettingInput
                      label="Интервал опроса баланса (sec)"
                      type="number"
                      value={globalConfig.balance_poll_interval_sec ?? 30}
                      onChange={v => updateGlobal('balance_poll_interval_sec', Math.min(600, Math.max(1, parseInt(v, 10) || 30)))}
                      min={1}
                      max={600}
                    />
                    <p className="text-xs text-gray-500">Как часто сервер запрашивает USDT-баланс; после сохранения — со следующего цикла опроса.</p>
                    <SettingInput
                      label="Inspector: интервал проверки (sec)"
                      type="number"
                      value={globalConfig.inspector_interval_sec ?? 5}
                      onChange={v =>
                        updateGlobal(
                          'inspector_interval_sec',
                          Math.min(300, Math.max(1, parseFloat(String(v).replace(',', '.')) || 1)),
                        )
                      }
                      min={1}
                      max={300}
                    />
                    <p className="text-xs text-gray-500">Инспектор ордеров: пауза между циклами; новое значение — с следующего цикла.</p>
                  </div>
                </SettingsCategory>

                <SettingsCategory
                  title="Predict Points"
                  subtitle="Гейт ликвидности: только рынки с активной почасовой наградой; фоновый опрос API"
                  open={globalSettingsOpenSection === 'points'}
                  onToggle={() => setGlobalSettingsOpenSection(s => (s === 'points' ? null : 'points'))}
                  iconSlot={
                    <div className="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center">
                      <Sparkles className="w-4 h-4 text-amber-400" strokeWidth={2} />
                    </div>
                  }
                >
                  <div className="space-y-3 pt-1">
                    <SettingCheckbox
                      label="Требовать активную награду (points/hr)"
                      checked={globalConfig.predict_points_require_active_reward !== false}
                      onChange={v => updateGlobal('predict_points_require_active_reward', v)}
                    />
                    <SettingInput
                      label="Опрос рынков (сек)"
                      type="number"
                      value={globalConfig.predict_points_market_poll_sec ?? 600}
                      onChange={v => updateGlobal('predict_points_market_poll_sec', Math.min(7200, Math.max(0, parseInt(v, 10) || 0)))}
                      min={0}
                      max={7200}
                    />
                    <p className="text-[11px] text-gray-500 leading-snug">
                      Пока награды нет — не выставляем лимитки (приоритетнее спреда и ликвидности). Раз в N секунд делаем GET /v1/markets для всех загруженных рынков: расписание на стороне Predict могут поменять в любой момент. При исчезновении награды во время работы ордера отменяются. 0 = не опрашивать (только метаданные с последней загрузки рынка).
                    </p>
                  </div>
                </SettingsCategory>

                <SettingsCategory
                  title="Рынки"
                  subtitle="Импорт и экспорт списка и настроек (как в async_v3), сброс всех рынков"
                  open={globalSettingsOpenSection === 'markets'}
                  onToggle={() => setGlobalSettingsOpenSection(s => (s === 'markets' ? null : 'markets'))}
                  iconSlot={
                    <div className="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center">
                      <Globe className="w-4 h-4 text-amber-400" strokeWidth={2} />
                    </div>
                  }
                >
                  <input
                    id="pf-markets-json-import"
                    type="file"
                    accept="application/json,.json"
                    className="sr-only"
                    onChange={handleMarketsImportFile}
                    disabled={marketsOpsBusy}
                  />
                  <div className="space-y-3 pt-1 text-sm text-gray-300">
                    <p className="text-xs text-gray-500 leading-relaxed">
                      <strong className="text-gray-400 font-medium">Только id</strong> — добавляются только те рынки из файла, которых ещё нет в списке; ваши текущие настройки не трогаем.{' '}
                      <strong className="text-gray-400 font-medium">С настройками</strong> — для уже загруженных id из файла обновляются настройки из JSON; новые id подгружаются и сразу получают настройки из файла. Экспорт: полный JSON или только список id. «Удалить все рынки»: выгрузка из сессии с сохранением или с очисткой{' '}
                      <span className="font-mono text-gray-400">token_settings.json</span>.
                    </p>
                    {marketsSectionError ? (
                      <p className="text-xs text-amber-400/95 leading-relaxed" role="alert">
                        {marketsSectionError}
                      </p>
                    ) : null}
                    {marketsImportInfo ? (
                      <p className="text-xs text-emerald-400/90 leading-relaxed" role="status">
                        {marketsImportInfo}
                      </p>
                    ) : null}
                    <div className="flex flex-col sm:flex-row flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={marketsOpsBusy}
                        onClick={() => handleMarketsExport(true)}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border border-dark-600 bg-dark-700 px-3 py-2 text-sm text-gray-200 hover:bg-dark-600 hover:border-bnb/40 transition-colors disabled:opacity-50"
                      >
                        <Download className="w-4 h-4 shrink-0" strokeWidth={2} />
                        Экспорт с настройками
                      </button>
                      <button
                        type="button"
                        disabled={marketsOpsBusy}
                        onClick={() => handleMarketsExport(false)}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border border-dark-600 bg-dark-700 px-3 py-2 text-sm text-gray-200 hover:bg-dark-600 hover:border-bnb/40 transition-colors disabled:opacity-50"
                      >
                        <Download className="w-4 h-4 shrink-0" strokeWidth={2} />
                        Экспорт только id
                      </button>
                      <label
                        htmlFor="pf-markets-json-import"
                        className={
                          'inline-flex items-center justify-center gap-2 rounded-lg border border-dark-600 bg-dark-700 px-3 py-2 text-sm text-gray-200 hover:bg-dark-600 hover:border-bnb/40 transition-colors select-none ' +
                          (marketsOpsBusy ? 'pointer-events-none opacity-50 cursor-not-allowed' : 'cursor-pointer')
                        }
                      >
                        <Upload className="w-4 h-4 shrink-0" strokeWidth={2} />
                        Импорт из файла…
                      </label>
                      <button
                        type="button"
                        disabled={marketsOpsBusy}
                        onClick={() => {
                          setMarketsSectionError(null)
                          setMarketsRemoveAllOpen(true)
                        }}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-2 text-sm text-red-200 hover:bg-red-500/20 transition-colors disabled:opacity-50"
                      >
                        <Trash2 className="w-4 h-4 shrink-0" strokeWidth={2} />
                        Удалить все рынки
                      </button>
                    </div>
                  </div>
                </SettingsCategory>

                <div className="space-y-3 pt-2">
                  {globalSettingsFeedback ? (
                    <div
                      role="status"
                      aria-live="polite"
                      className={
                        'flex items-start gap-3 rounded-xl px-4 py-3 border shadow-md transition-all duration-300 ' +
                        (globalSettingsFeedback.kind === 'ok'
                          ? 'border-emerald-500/45 bg-emerald-500/[0.12] text-emerald-50'
                          : 'border-red-500/45 bg-red-500/[0.12] text-red-50')
                      }
                    >
                      {globalSettingsFeedback.kind === 'ok' ? (
                        <CheckCircle2 className="w-5 h-5 shrink-0 text-emerald-400 mt-0.5" strokeWidth={2} aria-hidden />
                      ) : (
                        <AlertCircle className="w-5 h-5 shrink-0 text-red-400 mt-0.5" strokeWidth={2} aria-hidden />
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-semibold">
                          {globalSettingsFeedback.kind === 'ok' ? 'Глобальные настройки приняты' : 'Не удалось сохранить'}
                        </p>
                        <p className="text-xs text-gray-200/90 mt-1 leading-relaxed">{globalSettingsFeedback.text}</p>
                      </div>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    onClick={handleSaveGlobalSettings}
                    disabled={globalSettingsSaving}
                    className="w-full py-3 bg-bnb text-dark-900 rounded-xl text-sm font-semibold hover:bg-bnb-light transition-colors disabled:opacity-60 disabled:cursor-not-allowed shadow-md shadow-bnb/10"
                  >
                    {globalSettingsSaving ? 'Сохранение…' : 'Save Global Settings'}
                  </button>
                </div>
              </div>
            )}

            {settingsSubTab === 'global' && !globalConfig && (
              <div className="flex items-center justify-center h-64 text-gray-500"><p>Loading settings...</p></div>
            )}

            {settingsSubTab === 'accounts' && (
              <div className="max-w-xl mx-auto space-y-6">
                {!accounts[0] ? (
                  <div className="relative overflow-hidden rounded-2xl border border-dark-600 bg-gradient-to-b from-dark-800/95 to-dark-900 px-6 py-12 sm:px-10 text-center shadow-xl shadow-black/20">
                    <div className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-bnb/10 blur-3xl" aria-hidden />
                    <div className="relative mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-bnb/15 ring-1 ring-bnb/25">
                      <User className="h-8 w-8 text-bnb" strokeWidth={1.75} />
                    </div>
                    <h3 className="relative text-lg font-semibold text-gray-100">Нет сохранённого аккаунта</h3>
                    <p className="relative mt-2 text-sm text-gray-500 leading-relaxed max-w-sm mx-auto">
                      Сначала подключитесь через диалог входа — запись появится здесь, и вы сможете при необходимости отредактировать данные.
                    </p>
                    <button
                      type="button"
                      onClick={() => setShowConnect(true)}
                      className="relative mt-7 inline-flex items-center justify-center gap-2 rounded-xl bg-bnb px-6 py-3 text-sm font-semibold text-dark-900 shadow-md shadow-bnb/20 transition hover:bg-bnb-light"
                    >
                      <Link2 className="h-4 w-4" strokeWidth={2} />
                      Подключить аккаунт
                    </button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {accounts.length > 1 ? (
                      <div
                        role="status"
                        className="rounded-xl border border-amber-500/35 bg-amber-500/[0.08] px-4 py-3 text-xs text-amber-100/95 leading-relaxed"
                      >
                        В хранилище <span className="font-semibold tabular-nums">{accounts.length}</span> записей; в интерфейсе редактируется{' '}
                        <span className="font-medium">первая</span>. Софт рассчитан на один аккаунт — лишние строки при необходимости уберите из файла на сервере.
                      </div>
                    ) : null}

                    {(() => {
                      const primary = accounts[0]
                      const sessionMatches =
                        connected &&
                        accountAddress &&
                        primary.predict_account_address.toLowerCase() === accountAddress.toLowerCase()
                      return (
                        <div className="overflow-hidden rounded-2xl border border-dark-600 bg-dark-800/80 shadow-lg shadow-black/25">
                          <div className="border-b border-dark-600/80 bg-gradient-to-r from-dark-800 via-dark-800 to-bnb/5 px-5 py-4">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="min-w-0 flex items-start gap-3">
                                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-bnb/15 ring-1 ring-bnb/20">
                                  <User className="h-5 w-5 text-bnb" strokeWidth={2} />
                                </div>
                                <div className="min-w-0 text-left">
                                  <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Predict · адрес</div>
                                  <div className="mt-0.5 font-mono text-sm text-gray-100 break-all" title={primary.predict_account_address}>
                                    {primary.predict_account_address}
                                  </div>
                                  {nickname.trim() ? (
                                    <div className="mt-1 text-xs text-gray-500">
                                      Ник: <span className="text-gray-400">{nickname.trim()}</span>
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-2">
                                {sessionMatches ? (
                                  <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300">
                                    <Radio className="h-3 w-3" />
                                    Сессия активна
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1.5 rounded-full border border-dark-600 bg-dark-900/60 px-2.5 py-1 text-[11px] font-medium text-gray-500">
                                    Не подключено
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="space-y-6 p-5">
                            <div>
                              <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                                <KeyRound className="h-3.5 w-3.5 text-bnb/90" />
                                API Predict
                              </div>
                              <label className="block text-[11px] text-gray-500 mb-1.5">API Key</label>
                              <div className="relative">
                                <input
                                  type={accountFieldVisible.api ? 'text' : 'password'}
                                  autoComplete="off"
                                  value={accountForm.api_key}
                                  onChange={e => setAccountForm(prev => ({ ...prev, api_key: e.target.value }))}
                                  className="w-full rounded-lg border border-dark-600 bg-dark-900/70 py-2.5 pl-3 pr-10 font-mono text-sm text-gray-100 placeholder-gray-600 focus:border-bnb focus:outline-none focus:ring-1 focus:ring-bnb/35"
                                  placeholder="API key"
                                />
                                <button
                                  type="button"
                                  onClick={() => setAccountFieldVisible(v => ({ ...v, api: !v.api }))}
                                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-500 hover:text-gray-300"
                                  aria-label={accountFieldVisible.api ? 'Скрыть' : 'Показать'}
                                >
                                  {accountFieldVisible.api ? <EyeOff size={16} /> : <Eye size={16} />}
                                </button>
                              </div>
                            </div>

                            <div>
                              <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                                <Wallet className="h-3.5 w-3.5 text-bnb/90" />
                                Кошелёк
                              </div>
                              <label className="block text-[11px] text-gray-500 mb-1.5">Приватный ключ Privy</label>
                              <div className="relative">
                                <input
                                  type={accountFieldVisible.privy ? 'text' : 'password'}
                                  autoComplete="off"
                                  value={accountForm.privy_wallet_private_key}
                                  onChange={e => setAccountForm(prev => ({ ...prev, privy_wallet_private_key: e.target.value }))}
                                  className="w-full rounded-lg border border-dark-600 bg-dark-900/70 py-2.5 pl-3 pr-10 font-mono text-sm text-gray-100 placeholder-gray-600 focus:border-bnb focus:outline-none focus:ring-1 focus:ring-bnb/35"
                                  placeholder="0x…"
                                />
                                <button
                                  type="button"
                                  onClick={() => setAccountFieldVisible(v => ({ ...v, privy: !v.privy }))}
                                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-500 hover:text-gray-300"
                                  aria-label={accountFieldVisible.privy ? 'Скрыть' : 'Показать'}
                                >
                                  {accountFieldVisible.privy ? <EyeOff size={16} /> : <Eye size={16} />}
                                </button>
                              </div>
                            </div>

                            <div>
                              <label className="block text-[11px] text-gray-500 mb-1.5">Адрес аккаунта (0x…)</label>
                              <input
                                type="text"
                                autoComplete="off"
                                value={accountForm.predict_account_address}
                                onChange={e => setAccountForm(prev => ({ ...prev, predict_account_address: e.target.value }))}
                                className="w-full rounded-lg border border-dark-600 bg-dark-900/70 px-3 py-2.5 font-mono text-sm text-gray-100 focus:border-bnb focus:outline-none focus:ring-1 focus:ring-bnb/35"
                                placeholder="0x…"
                              />
                            </div>

                            <div>
                              <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                                <Globe className="h-3.5 w-3.5 text-bnb/90" />
                                Сеть (необязательно)
                              </div>
                              <label className="block text-[11px] text-gray-500 mb-1.5">HTTP(S) proxy</label>
                              <div className="relative">
                                <input
                                  type={accountFieldVisible.proxy ? 'text' : 'password'}
                                  autoComplete="off"
                                  value={accountForm.proxy}
                                  onChange={e => setAccountForm(prev => ({ ...prev, proxy: e.target.value }))}
                                  className="w-full rounded-lg border border-dark-600 bg-dark-900/70 py-2.5 pl-3 pr-10 font-mono text-sm text-gray-100 placeholder-gray-600 focus:border-bnb focus:outline-none focus:ring-1 focus:ring-bnb/35"
                                  placeholder="http://user:pass@host:port"
                                />
                                <button
                                  type="button"
                                  onClick={() => setAccountFieldVisible(v => ({ ...v, proxy: !v.proxy }))}
                                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-500 hover:text-gray-300"
                                  aria-label={accountFieldVisible.proxy ? 'Скрыть' : 'Показать'}
                                >
                                  {accountFieldVisible.proxy ? <EyeOff size={16} /> : <Eye size={16} />}
                                </button>
                              </div>
                            </div>
                          </div>

                          <div className="space-y-3 border-t border-dark-600/80 bg-dark-900/30 px-5 py-4">
                            {accountFeedback ? (
                              <div
                                role="status"
                                className={
                                  'flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm ' +
                                  (accountFeedback.kind === 'ok'
                                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
                                    : 'border-red-500/40 bg-red-500/10 text-red-100')
                                }
                              >
                                {accountFeedback.kind === 'ok' ? (
                                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                                ) : (
                                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                                )}
                                <span>{accountFeedback.text}</span>
                              </div>
                            ) : null}
                            <button
                              type="button"
                              onClick={() => void handleSaveAccountSettings()}
                              disabled={accountSaveLoading}
                              className="w-full rounded-xl bg-bnb py-3 text-sm font-semibold text-dark-900 shadow-md shadow-bnb/15 transition hover:bg-bnb-light disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {accountSaveLoading ? 'Сохранение…' : 'Сохранить изменения'}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (
                                  typeof window !== 'undefined' &&
                                  !window.confirm('Удалить сохранённый аккаунт из списка на сервере? Подключение придётся настроить заново.')
                                ) {
                                  return
                                }
                                void handleDeleteAccount()
                              }}
                              className="w-full rounded-xl border border-red-500/30 bg-transparent py-2.5 text-sm font-medium text-red-300/95 transition hover:bg-red-500/10"
                            >
                              Удалить из сохранённых
                            </button>
                          </div>
                        </div>
                      )
                    })()}
                  </div>
                )}
              </div>
            )}

          </div>
        )}

        {activeTab === 'autosell' && <AutosellPanel connected={connected} />}
        {activeTab === 'statistics' && <StatisticsPanel />}
      </div>

      {showLogs && (
        <LogOverlay
          logs={logs}
          onClose={() => {
            setShowLogs(false)
            setLogHighlightTerms(undefined)
          }}
          onClear={handleClearLogs}
          highlightContainsAll={logHighlightTerms}
        />
      )}
      {showConnect && (
        <ConnectDialog
          onConnect={handleConnect}
          onClose={() => { setShowConnect(false); setConnectBootstrapError('') }}
          savedCredentials={savedCredentials}
          bootstrapError={connectBootstrapError}
        />
      )}
      {showAddMarket && <AddMarketDialog onLoad={async (ids: string[]) => { await api.loadMarkets(ids); setShowAddMarket(false) }} onClose={() => setShowAddMarket(false)} />}
      {marketSettingsModalId && (
        <MarketSettingsDialog
          marketId={marketSettingsModalId}
          marketTitle={markets[marketSettingsModalId]?.title}
          onClose={() => setMarketSettingsModalId(null)}
          onSaved={({ settings: s, settings_updated_at: ts }) => {
            const id = marketSettingsModalId
            clearPendingMarketSSE()
            setMarkets(prev =>
              prev[id]
                ? { ...prev, [id]: { ...prev[id], settings: s, settings_updated_at: ts } }
                : prev,
            )
          }}
        />
      )}
      {showGlobalBatch && (
        <GlobalBatchSettingsDialog
          marketIds={Object.keys(markets)}
          seed={sortedMarkets[0]?.settings ?? null}
          onClose={() => setShowGlobalBatch(false)}
          onApplied={async () => {
            try {
              clearPendingMarketSSE()
              const states = await api.getAllMarketsState()
              setMarkets(states)
            } catch {
              /* ignore */
            }
          }}
        />
      )}

      {marketsImportData !== null && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 animate-fadeIn"
          role="dialog"
          aria-modal="true"
          aria-labelledby="markets-import-title"
          onClick={() => !marketsOpsBusy && setMarketsImportData(null)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-dark-600 bg-dark-800 p-5 shadow-xl animate-slideDown"
            onClick={e => e.stopPropagation()}
          >
            <h3 id="markets-import-title" className="text-lg font-semibold text-gray-100">
              Импорт рынков
            </h3>
            <p className="mt-2 text-sm text-gray-400 leading-relaxed">
              <strong className="text-gray-300">С настройками</strong> — обновить настройки у уже загруженных рынков из файла и добавить только новые id с настройками из файла.{' '}
              <strong className="text-gray-300">Только id</strong> — добавить только те id, которых ещё нет; ваши настройки не меняем, для новых — базовые по умолчанию.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <button
                type="button"
                disabled={marketsOpsBusy}
                onClick={() => runMarketsImport(true)}
                className="w-full rounded-lg bg-bnb py-2.5 text-sm font-semibold text-dark-900 hover:bg-bnb-light transition-colors disabled:opacity-50"
              >
                С настройками (обновить существующие + новые)
              </button>
              <button
                type="button"
                disabled={marketsOpsBusy}
                onClick={() => runMarketsImport(false)}
                className="w-full rounded-lg border border-dark-600 bg-dark-700 py-2.5 text-sm font-medium text-gray-200 hover:bg-dark-600 transition-colors disabled:opacity-50"
              >
                Только id (добавить только отсутствующие)
              </button>
              <button
                type="button"
                disabled={marketsOpsBusy}
                onClick={() => setMarketsImportData(null)}
                className="w-full rounded-lg py-2 text-sm text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-50"
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      {marketsRemoveAllOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 animate-fadeIn"
          role="dialog"
          aria-modal="true"
          aria-labelledby="markets-remove-all-title"
          onClick={() => !marketsOpsBusy && setMarketsRemoveAllOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-dark-600 bg-dark-800 p-5 shadow-xl animate-slideDown"
            onClick={e => e.stopPropagation()}
          >
            <h3 id="markets-remove-all-title" className="text-lg font-semibold text-gray-100">
              Удалить все рынки
            </h3>
            <p className="mt-2 text-sm text-gray-400 leading-relaxed">
              Убрать только загруженные рынки из сессии (настройки в файле сохранятся — при повторном добавлении id подтянутся) или также удалить записи настроек для этих рынков (при следующем добавлении — с чистого листа)?
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <button
                type="button"
                disabled={marketsOpsBusy}
                onClick={() => runRemoveAllMarkets(true)}
                className="w-full rounded-lg bg-red-600/90 py-2.5 text-sm font-semibold text-white hover:bg-red-500 transition-colors disabled:opacity-50"
              >
                Удалить рынки и настройки в файле
              </button>
              <button
                type="button"
                disabled={marketsOpsBusy}
                onClick={() => runRemoveAllMarkets(false)}
                className="w-full rounded-lg border border-dark-600 bg-dark-700 py-2.5 text-sm font-medium text-gray-200 hover:bg-dark-600 transition-colors disabled:opacity-50"
              >
                Только рынки (настройки сохранить)
              </button>
              <button
                type="button"
                disabled={marketsOpsBusy}
                onClick={() => setMarketsRemoveAllOpen(false)}
                className="w-full rounded-lg py-2 text-sm text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-50"
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
