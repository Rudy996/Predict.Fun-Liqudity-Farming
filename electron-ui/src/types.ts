export interface TokenSettings {
  market_id: string
  position_size_usdt: number | null
  position_size_shares: number | null
  min_spread: number | null
  enabled: boolean
  target_liquidity: number
  max_auto_spread: number
  liquidity_mode: string
  volatile_reposition_limit: number | null
  volatile_window_seconds: number | null
  volatile_cooldown_seconds: number | null
  /** Мин. расхождение цены (доля 0–1), ниже — не переставлять из‑за шума стакана */
  reposition_min_price_delta?: number
  is_custom: boolean
}

/** График Predict Points по рынку (REST: market.rewards) */
export interface MarketRewardPeriod {
  hourlyRate: number
  startsAt: string
  endsAt: string
}

export interface MarketRewards {
  current?: MarketRewardPeriod | null
  schedule?: MarketRewardPeriod[]
}

export interface OrderInfo {
  mid_price_yes: number
  mid_price_no: number
  best_bid_yes: number
  best_ask_yes: number
  buy_yes: { price: number; shares: number; value_usd: number } | null
  buy_no: { price: number; shares: number; value_usd: number } | null
  total_value_usd: number
  liquidity_yes: number
  liquidity_no: number
  can_place_yes: boolean
  can_place_no: boolean
  min_liquidity: number
  spread_yes: number
  spread_no: number
  min_spread: number
  can_place_yes_liquidity: boolean
  can_place_no_liquidity: boolean
  can_place_yes_spread: boolean
  can_place_no_spread: boolean
  /** Сервер: нет активной почасовой награды Predict Points (гейт ликвидности) */
  predict_points_blocked?: boolean
}

export interface ActiveOrder {
  order_id: string | null
  hash: string
  price: number
  shares: number
  outcome: string
}

export interface MarketState {
  market_id: string
  title: string
  question: string
  slug: string
  /** Как market_info.categorySlug в async_v3 — участвует в ссылке predict.fun если slug пустой */
  categorySlug?: string
  status: string
  decimalPrecision: number
  imageUrl: string | null
  order_info: OrderInfo | null
  orderbook: { bids: [number, number][]; asks: [number, number][] } | null
  settings: TokenSettings | null
  /** Unix time: последнее изменение настроек на сервере (не путать с update_time стакана) */
  settings_updated_at?: number | null
  update_time: number | null
  prev_orderbook_time: number | null
  mid_price: number | null
  best_bid: number | null
  best_ask: number | null
  active_orders: { yes: ActiveOrder | null; no: ActiveOrder | null }
  /** Соответствует executor.is_collateral_cooldown */
  collateral_cooldown?: boolean
  /** Unix sec: конец паузы после insufficient collateral (пока активна) */
  collateral_cooldown_until?: number | null
  outcome_blocked_yes?: boolean
  outcome_blocked_no?: boolean
  /** Сессия: пользователь явно включил слежение (Place / place-all); без этого автоликвидность по WS не идёт */
  liquidity_session_armed?: boolean
  /** Пауза по защите от волатильности (async_v3: лимит переставлений в окне) */
  liquidity_volatile_in_cooldown?: boolean
  /** Unix sec: конец паузы по волатильности (пока активна) */
  liquidity_volatile_cooldown_until?: number | null
  /** Награды Predict Points (текущий период и расписание с API) */
  rewards?: MarketRewards | null
}

export interface LogMessage {
  message: string
  level: string
  timestamp: number
}

export interface SSEStatus {
  connected: boolean
  ws_connected: boolean
  balance: number
  /** Unix sec: последний опрос USDT-баланса на сервере */
  balance_updated_at?: number
  inspector_orders_count: number
  /** Сколько открытых ордеров на счёте — это лимитки AutoSell (для подписи +N AutoSell) */
  inspector_autosell_open_count?: number
  /** Время последнего опроса API ордеров инспектором (unix sec) */
  inspector_orders_updated_at?: number
  inspector_enabled?: boolean
  ws_last_update: number
  market_loading_progress?: { current: number; total: number; loading: boolean }
}

export interface GlobalConfig {
  websocket_pool_size: number
  websocket_dedupe_identical_sec: number
  websocket_connect_stagger_ms: number
  websocket_slow_slot_rebalance_sec: number
  websocket_slow_slot_min_spread: number
  websocket_slow_slot_min_top: number
  websocket_slow_slots_per_rebalance: number
  websocket_dedupe_depth_levels: number
  websocket_pool_verbose: boolean
  websocket_pool_realtime_log: boolean
  telegram_enabled: boolean
  telegram_token: string
  telegram_chat_id: string
  telegram_status_interval_minutes: number
  insufficient_collateral_cooldown_sec: number
  /** Интервал опроса баланса на сервере (сек), по умолчанию 30 */
  balance_poll_interval_sec: number
  /** Пауза между циклами инспектора ордеров (сек), по умолчанию 5 */
  inspector_interval_sec: number
  log_software: boolean
  log_orderbook: boolean
  log_orders: boolean
  sort_mode: number
  inspector_enabled: boolean
  /** Подробные строки [diag] в консоли main.py (поток [Server]) */
  console_diagnostics: boolean
  /** Одновременно рынков при Place All / Cancel All (1–100) */
  orders_all_max_concurrent: number
  /** Одновременных запросов при загрузке рынков после коннекта / Add Market (1–100) */
  market_load_max_concurrent: number
  /** Требовать активную награду Predict Points для выставления ликвидности */
  predict_points_require_active_reward: boolean
  /** Период опроса GET /v1/markets/{id} для актуального rewards (сек). 0 — только при загрузке рынка */
  predict_points_market_poll_sec: number
}

export type AutosellLoadStage =
  | 'idle'
  | 'requesting_positions'
  | 'enriching_markets'
  | 'assembling'

/** Карточка: новая позиция → выставленная лимитная продажа и статус ордера */
export interface AutosellTrackedSell {
  position_id: string
  market_id: string
  /** URL обложки рынка (как в позициях) */
  market_image?: string | null
  title: string
  outcome: string
  avg_buy: number | null
  target_loss_percent: number
  effective_loss_percent: number | null
  limit_price: number | null
  shares: number | null
  order_id: string | null
  /** GET /v1/orders/{hash}: path = data.order.hash; без него опрос идёт по id через списки */
  order_hash?: string | null
  status: string
  error?: string | null
  updated_at: number
  amount_filled?: string | number | null
  order_updated_at?: number
  /** Unix sec: когда истечёт пауза перед выставлением лимита (status === delay) */
  delay_ends_at?: number | null
  /** Срок жизни лимитки в подписи (сек), если задан в настройках */
  order_expiration_sec?: number | null
}

export interface AutosellState {
  connected: boolean
  /** Главный выключатель: опрос позиций и автопродажа (хранится в autosell_settings.json) */
  autosell_enabled?: boolean
  poll_interval_sec: number
  /** Интервал опроса GET /v1/orders (hash/id) для карточек автопродажи */
  order_status_interval_sec: number
  /** Макс. дисконт от средней покупки (%%), в UI показываем как −N% */
  max_loss_percent: number
  /** Пауза перед лимитной продажей (сек). 0 — сразу. */
  delay_before_sell_sec?: number
  /** Срок жизни лимитного ордера в подписи (сек). 0 — по умолчанию SDK; иначе ≥ 120 (API). */
  order_expiration_sec?: number
  /** Последние срабатывания автопродажи (новые сверху) */
  tracked_sells: AutosellTrackedSell[]
  positions: Record<string, unknown>[]
  positions_updated_at: number
  /** После первого ответа GET /v1/positions в сессии (даже если список пуст) */
  positions_first_fetch_done: boolean
  /** Подэтап первой загрузки (потом idle) */
  positions_load_stage?: AutosellLoadStage
  /** Прогресс подгрузки рынков: current/total */
  positions_enrich_progress?: { current: number; total: number } | null
}

export interface MarketInfo {
  id: string
  title: string
  question: string
  slug: string
  status: string
  decimalPrecision: number
  imageUrl: string | null
  categorySlug: string | null
  isNegRisk: boolean
}

/** /api/stats — uptime процесса и накопленный за всё время */
export interface StatsSnapshot {
  session_uptime_sec: number
  lifetime_uptime_sec: number
  /** Успешно выставленные лимитки AutoSell (текущий процесс) */
  autosell_triggers_session: number
  /** Успешно выставленные лимитки AutoSell за всё время (файл data) */
  autosell_triggers_lifetime: number
}
