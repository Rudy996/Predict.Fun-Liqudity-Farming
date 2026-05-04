/** Защита от NaN/undefined при отрисовке — иначе .toFixed() валит весь React-дерево (серый экран). */

export function safeNum(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function fmtFixed(v: unknown, digits: number, fallback = '—'): string {
  const n = safeNum(v, NaN)
  return Number.isFinite(n) ? n.toFixed(digits) : fallback
}

export function safeJsonEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
