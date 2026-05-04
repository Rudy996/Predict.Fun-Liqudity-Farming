/**
 * Как в async_v3/gui.py _parse_add_market_input:
 * URL predict.fun/market/<slug> → категория по slug; иначе — список Market ID.
 */
export type ParsedAddMarketInput =
  | { kind: 'slug'; slug: string }
  | { kind: 'ids'; ids: string[] }

export function parseAddMarketInput(text: string): ParsedAddMarketInput | null {
  const t = (text || '').trim()
  if (!t) return null

  const urlMatch = t.match(/predict\.fun\/markets?\/([a-zA-Z0-9_-]+)/i)
  if (urlMatch?.[1]) {
    return { kind: 'slug', slug: urlMatch[1] }
  }

  const ids = t
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(Boolean)
  if (ids.length > 0) {
    return { kind: 'ids', ids }
  }
  return null
}
