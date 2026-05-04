import type {
  MarketState,
  LogMessage,
  SSEStatus,
  GlobalConfig,
  TokenSettings,
  MarketInfo,
  AutosellState,
  StatsSnapshot,
} from './types'

/**
 * Обёртка над EventSource: UI видит readyState + «тишину» потока и может перезапустить подписку,
 * не трогая нативный объект. Нужно против «серого экрана» при долгом простое.
 */
export type LiveStream = {
  close: () => void
  getReadyState: () => number
  getMsSinceLastEvent: () => number
}

let BASE_URL = 'http://127.0.0.1:8765'

export function setBaseUrl(url: string) {
  BASE_URL = url
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  const text = await res.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { success: false, error: text.slice(0, 300) || `HTTP ${res.status}` }
  }
  if (
    !res.ok &&
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    (data as Record<string, unknown>).error == null &&
    (data as Record<string, unknown>).detail != null
  ) {
    const d = data as Record<string, unknown>
    const det = d.detail
    d.error = typeof det === 'string' ? det : JSON.stringify(det)
  }
  return data as T
}

export const api = {
  connect: (data: { api_key: string; predict_account_address: string; privy_wallet_private_key: string; proxy?: string }) =>
    request<{ success: boolean; jwt_token?: string; account_info?: { address: string; balance: number; nickname: string }; error?: string }>(
      '/api/auth/connect',
      { method: 'POST', body: JSON.stringify(data) },
    ),

  disconnect: () =>
    request<{ success: boolean }>('/api/auth/disconnect', { method: 'POST' }),

  /** Сессия на FastAPI; после перезагрузки окна UI узнаёт, что connect уже был. */
  getAuthStatus: () =>
    request<{ connected: boolean; ws_connected?: boolean }>('/api/auth/status'),

  getCredentials: () =>
    request<{ api_key?: string; predict_account_address?: string; privy_wallet_private_key?: string; proxy?: string }>('/api/credentials'),

  getAccountInfo: () =>
    request<{ address: string; nickname: string; balance: number; balance_updated_at: number; error?: string }>('/api/account/info'),

  getBalance: () =>
    request<{ balance: number; updated_at: number }>('/api/account/balance'),

  refreshBalance: () =>
    request<{ success: boolean; balance: number }>('/api/account/refresh-balance', { method: 'POST' }),

  getAutosell: () => request<AutosellState>('/api/autosell'),

  getStats: () => request<StatsSnapshot>('/api/stats'),

  setAutosellSettings: (data: {
    enabled?: boolean
    interval_sec?: number
    max_loss_percent?: number
    order_status_interval_sec?: number
    delay_before_sell_sec?: number
    order_expiration_sec?: number
  }) =>
    request<{
      success: boolean
      autosell_enabled?: boolean
      poll_interval_sec?: number
      order_status_interval_sec?: number
      max_loss_percent?: number
      delay_before_sell_sec?: number
      order_expiration_sec?: number
      error?: string
    }>('/api/autosell/settings', { method: 'POST', body: JSON.stringify(data) }),

  setAutosellPollInterval: (interval_sec: number) =>
    request<{ success: boolean; poll_interval_sec?: number; error?: string }>('/api/autosell/poll-interval', {
      method: 'POST',
      body: JSON.stringify({ interval_sec }),
    }),

  loadMarkets: (market_ids: string[]) =>
    request<{ success: boolean; loaded?: Record<string, any>; count?: number; error?: string }>(
      '/api/markets/load',
      { method: 'POST', body: JSON.stringify({ market_ids }) },
    ),

  /** Экспорт списка рынков и опционально настроек (как async_v3). */
  getMarketsExport: (includeSettings: boolean) =>
    request<Record<string, unknown>>(`/api/markets/export?include_settings=${includeSettings}`),

  /** Импорт JSON: см. parse_market_import_root на сервере. */
  importMarkets: (data: unknown, applySettings: boolean) =>
    request<{
      success: boolean
      loaded?: Record<string, unknown>
      count?: number
      error?: string
      message?: string
      skipped_existing_count?: number
      updated_existing_settings_count?: number
    }>('/api/markets/import', {
      method: 'POST',
      body: JSON.stringify({ data, apply_settings: applySettings }),
    }),

  /** Удалить все загруженные рынки; remove_settings — также очистить token_settings.json по этим id. */
  removeAllMarkets: (removeSettings: boolean) =>
    request<{ success: boolean; removed_count?: number; removed_settings_count?: number; error?: string }>(
      '/api/markets/remove-all',
      { method: 'POST', body: JSON.stringify({ remove_settings: removeSettings }) },
    ),

  removeMarket: (market_id: string) =>
    request<{ success: boolean }>(`/api/markets/${market_id}`, { method: 'DELETE' }),

  listMarkets: () =>
    request<{ markets: MarketInfo[] }>('/api/markets'),

  getAllMarketsState: () =>
    request<Record<string, MarketState>>('/api/markets/state'),

  getMarketState: (market_id: string) =>
    request<MarketState>(`/api/markets/${market_id}/state`),

  fetchCategory: (slug: string) =>
    request<{ markets?: MarketInfo[]; title?: string; imageUrl?: string | null; error?: string }>(
      `/api/markets/category/${slug}`,
      { method: 'POST' },
    ),

  getAllSettings: () =>
    request<{ settings: Record<string, TokenSettings> }>('/api/settings'),

  getMarketSettings: (market_id: string) =>
    request<TokenSettings>(`/api/settings/${market_id}`),

  updateMarketSettings: (market_id: string, data: Partial<TokenSettings>) =>
    request<{ success: boolean; settings: TokenSettings; settings_updated_at: number }>(
      `/api/settings/${market_id}`,
      { method: 'PUT', body: JSON.stringify(data) },
    ),

  /** Явно включить сессию слежения (автоликвидность по стакану); вызывать с кнопки Place */
  armLiquiditySession: (market_id: string) =>
    request<{ success: boolean; settings?: TokenSettings; settings_updated_at?: number; error?: string }>(
      `/api/liquidity/arm/${market_id}`,
      { method: 'POST' },
    ),

  updateGlobalSettings: (market_ids: string[], data: Partial<TokenSettings>) =>
    request<{ success: boolean; updated_count?: number; error?: string }>(
      '/api/settings/global',
      { method: 'PUT', body: JSON.stringify({ market_ids, ...data }) },
    ),

  placeOrder: (market_id: string, outcome: string, price: number, shares: number) =>
    request<{ success: boolean; order?: unknown; error?: string }>(
      `/api/orders/place/${market_id}`,
      { method: 'POST', body: JSON.stringify({ outcome, price, shares }) },
    ),

  cancelOrder: (market_id: string, cancel_reason?: string) =>
    request<{ success: boolean }>(
      `/api/orders/cancel/${market_id}`,
      { method: 'POST', body: JSON.stringify({ cancel_reason }) },
    ),

  cancelAllOrders: () =>
    request<{ success: boolean; cancelled_count: number }>('/api/orders/cancel-all', { method: 'POST' }),

  placeAllOrders: () =>
    request<{ success: boolean; placed_count: number }>('/api/orders/place-all', { method: 'POST' }),

  getActiveOrders: () =>
    request<Record<string, { yes: any; no: any }>>('/api/orders/active'),

  getApiOrdersCount: () =>
    request<{ count: number; updated_at: number }>('/api/orders/api-count'),

  enableInspector: () =>
    request<{ success: boolean }>('/api/inspector/enable', { method: 'POST' }),

  disableInspector: () =>
    request<{ success: boolean }>('/api/inspector/disable', { method: 'POST' }),

  getInspectorStatus: () =>
    request<{ enabled: boolean; orders_count: number; updated_at: number }>('/api/inspector/status'),

  getWsStatus: () =>
    request<{ connected: boolean; pool_size: number; live_slots: number; last_update: number }>('/api/ws/status'),

  getConfig: () =>
    request<GlobalConfig>('/api/config'),

  updateConfig: (data: Partial<GlobalConfig>) =>
    request<{ success: boolean }>('/api/config', { method: 'PUT', body: JSON.stringify(data) }),

  telegramSendTest: (opts: {
    mode: 'summary' | 'balance'
    telegram_token?: string
    telegram_chat_id?: string
  }) =>
    request<{ success: boolean; error?: string }>('/api/telegram/test', {
      method: 'POST',
      body: JSON.stringify({
        mode: opts.mode,
        telegram_token: opts.telegram_token,
        telegram_chat_id: opts.telegram_chat_id,
      }),
    }),

  getMarketLoadingProgress: () =>
    request<{ current: number; total: number; loading: boolean }>('/api/market-loading'),

  getAccounts: () =>
    request<{ accounts: { api_key: string; predict_account_address: string; privy_wallet_private_key: string; proxy?: string }[] }>('/api/accounts'),

  deleteAccount: (index: number) =>
    request<{ success: boolean; error?: string }>(`/api/accounts/${index}`, { method: 'DELETE' }),

  updateAccount: (index: number, data: { api_key: string; predict_account_address: string; privy_wallet_private_key: string; proxy?: string }) =>
    request<{ success: boolean; error?: string }>(`/api/accounts/${index}`, { method: 'PUT', body: JSON.stringify(data) }),

  getLogs: (since = 0) =>
    request<{ logs: LogMessage[] }>(`/api/logs?since=${since}`),

  clearLogs: () => request<{ success: boolean }>('/api/logs/clear', { method: 'POST' }),

  subscribeEvents: (
    onLog: (log: LogMessage) => void,
    onState: (states: Record<string, MarketState>) => void,
    onStatus: (status: SSEStatus) => void,
  ): LiveStream => {
    const es = new EventSource(`${BASE_URL}/api/events`)
    let lastEventAt = Date.now()
    const touch = () => { lastEventAt = Date.now() }

    es.addEventListener('log', (e) => {
      touch()
      try { onLog(JSON.parse(e.data)) } catch { /* ignore */ }
    })

    es.addEventListener('state', (e) => {
      touch()
      try { onState(JSON.parse(e.data)) } catch { /* ignore */ }
    })

    es.addEventListener('status', (e) => {
      touch()
      try { onStatus(JSON.parse(e.data)) } catch { /* ignore */ }
    })

    es.onopen = () => { touch() }
    es.onerror = () => {
      // EventSource auto-reconnects; дополнительно за readyState следит watchdog в UI
    }

    return {
      close: () => { try { es.close() } catch { /* ignore */ } },
      getReadyState: () => es.readyState,
      getMsSinceLastEvent: () => Date.now() - lastEventAt,
    }
  },

  setBaseUrl,
}
