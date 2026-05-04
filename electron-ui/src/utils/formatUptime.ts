/** Человекочитаемый uptime из секунд (целые секунды). */
export function formatUptimeSeconds(totalSec: number): string {
  let s = Math.max(0, Math.floor(totalSec))
  const d = Math.floor(s / 86400)
  s %= 86400
  const h = Math.floor(s / 3600)
  s %= 3600
  const m = Math.floor(s / 60)
  const sec = s % 60
  if (d > 0) return `${d} д ${h} ч ${m} мин ${sec} с`
  if (h > 0) return `${h} ч ${m} мин ${sec} с`
  if (m > 0) return `${m} мин ${sec} с`
  return `${sec} с`
}
