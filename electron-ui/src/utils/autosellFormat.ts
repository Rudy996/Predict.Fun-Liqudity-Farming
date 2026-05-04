/** 18 decimals как у on-chain токенов предикт-рынков (shares, avg price в raw). */
const W18 = 10n ** 18n

function humanTrim(n: number, maxFrac: number): string {
  if (!Number.isFinite(n)) return '—'
  const t = n
    .toFixed(maxFrac)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '')
  return t || '0'
}

/**
 * Форматирует shares / среднюю цену из ответа API:
 * - большие целые строки (`101146000000000000000`) → деление на 1e18 → ~101.146
 * - уже малые числа (0.52) оставляет как есть
 */
export function formatPredictTokenAmount(raw: unknown, maxFrac = 6): string {
  if (raw === null || raw === undefined) return '—'
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return '—'
    if (Math.abs(raw) < 1e12) return humanTrim(raw, maxFrac)
  }
  const s0 = String(raw).trim()
  if (!s0 || s0 === 'null') return '—'

  if (/^-?\d+\.\d+$/.test(s0) && s0.length < 22) {
    return humanTrim(Number(s0), maxFrac)
  }

  const neg = s0.startsWith('-')
  const digits = s0.replace(/^-/, '').split(/[.eE]/)[0]
  if (!/^\d+$/.test(digits)) {
    const n = Number(s0)
    if (Number.isFinite(n) && Math.abs(n) < 1e15) return humanTrim(n, maxFrac)
    return '—'
  }

  try {
    let bi = BigInt(digits)
    if (neg) bi = -bi
    const sign = bi < 0n ? '-' : ''
    const abs = bi < 0n ? -bi : bi

    if (abs < 10n ** 12n) {
      return sign + humanTrim(Number(bi), maxFrac)
    }

    const whole = abs / W18
    const fracPart = abs % W18
    const scale = 10n ** BigInt(Math.min(maxFrac, 18))
    let fracDigits = (fracPart * scale) / W18
    let fracStr = fracDigits.toString().padStart(Math.min(maxFrac, 18), '0').replace(/0+$/, '')
    if (fracStr.length > maxFrac) fracStr = fracStr.slice(0, maxFrac).replace(/0+$/, '')
    const w = sign + whole.toString()
    return fracStr ? `${w}.${fracStr}` : w
  } catch {
    return '—'
  }
}

function isPresent(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'string' && v.trim() === '') return false
  return true
}

function getKeyCI(obj: Record<string, unknown>, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key]
  const lk = key.toLowerCase()
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lk) return obj[k]
  }
  return undefined
}

/** Имена полей средней цены входа в ответах Predict (camelCase / snake_case, иногда вложенно). */
const AVG_PRICE_KEYS = [
  'averageBuyPrice',
  'averagePrice',
  'avgBuyPrice',
  'avgPrice',
  'averageEntryPrice',
  'average_entry_price',
  'avg_entry_price',
  'entryPrice',
  'entry_price',
  'averageOpenPrice',
  'openAvgPrice',
  'meanEntryPrice',
  'meanPrice',
  'averageCost',
  'avgCost',
  'averagePricePerShare',
  'avgOpenPrice',
  'avg_open_price',
  'openPrice',
  'buyPrice',
  'buyAveragePrice',
  'averageBuy',
]

/**
 * Достаёт сырое значение средней цены входа — в API имя поля может отличаться или лежать в token/outcome/market.
 */
export function pickAveragePriceRaw(p: Record<string, unknown>): unknown {
  for (const k of AVG_PRICE_KEYS) {
    const v = getKeyCI(p, k)
    if (isPresent(v)) return v
  }
  const nestKeys = ['token', 'outcome', 'details', 'detail', 'position', 'market', 'data']
  for (const nk of nestKeys) {
    const n = p[nk]
    if (n && typeof n === 'object' && !Array.isArray(n)) {
      const o = n as Record<string, unknown>
      for (const k of AVG_PRICE_KEYS) {
        const v = getKeyCI(o, k)
        if (isPresent(v)) return v
      }
    }
  }
  for (const k of Object.keys(p)) {
    const kl = k.toLowerCase()
    if (
      (kl.includes('avg') || kl.includes('average') || kl.includes('mean') || kl.includes('entry')) &&
      kl.includes('price')
    ) {
      const v = p[k]
      if (isPresent(v)) return v
    }
  }
  return undefined
}

/** AVG buy: только центы (0.059 → 5.9¢). Вне диапазона 0–1 — как в API. */
export function formatAvgBuyCentsOnly(raw: unknown): string {
  const s = formatPredictTokenAmount(raw, 10)
  if (s === '—') return '—'
  const x = parseFloat(s.replace(/,/g, ''))
  if (!Number.isFinite(x)) return s
  if (x >= 0 && x <= 1) {
    const cents = x * 100
    let cFmt: string
    if (cents < 0.01) {
      cFmt = cents.toFixed(4).replace(/\.?0+$/, '')
    } else if (cents < 10) {
      cFmt = cents.toFixed(2).replace(/\.?0+$/, '')
    } else {
      cFmt = cents.toFixed(1).replace(/\.0$/, '')
    }
    return `${cFmt}¢`
  }
  return s
}

/**
 * Стоимость позиции в USD: не показывать обманчивое $0.00 при мелкой сумме.
 */
export function formatUsdPosition(v: unknown): string {
  if (v == null || v === '') return '—'
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n === 0) return '$0.00'
  if (n > 0 && n < 0.0001) return '< $0.01'
  if (n < 0.01) {
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 })
  }
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

/** Текст для поля outcome, если пришёл объект (иначе "[object Object]"). */
export function formatOutcomeLabel(raw: unknown): string {
  if (raw == null) return '—'
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    return String(raw)
  }
  if (Array.isArray(raw)) {
    return raw.map(formatOutcomeLabel).filter(Boolean).join(', ') || '—'
  }
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    const v =
      o.name ??
      o.label ??
      o.title ??
      o.side ??
      o.outcome ??
      o.token ??
      o.symbol ??
      o.text
    if (v != null && typeof v !== 'object') return String(v)
    if (typeof o.yes === 'boolean') return o.yes ? 'Yes' : 'No'
    return JSON.stringify(raw)
  }
  return String(raw)
}
