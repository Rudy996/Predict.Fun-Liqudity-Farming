/**
 * Как async_v3 MarketCard (gui.py):
 * slug = market_info.get("slug") or market_info.get("categorySlug") or market_id
 * if "/" in slug: slug = slug.split("/")[-1]
 * url = f"https://predict.fun/market/{slug}"
 */
export function predictFunMarketUrl(
  slug: string | undefined | null,
  categorySlug: string | undefined | null,
  marketId: string
): string | null {
  let s = (slug ?? '').trim() || (categorySlug ?? '').trim() || (marketId ?? '').trim()
  if (!s) return null
  if (s.includes('/')) {
    const parts = s.split('/').filter(Boolean)
    s = parts[parts.length - 1] ?? s
  }
  return `https://predict.fun/market/${s}`
}
