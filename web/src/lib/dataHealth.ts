/**
 * Canonical DataHealth + resample for both CSV and Angel paths.
 * Angel and CSV must go through the same health gate and same resample
 * so a CSV and an Angel fetch over the same range are deep-equal after resample.
 */

export interface HealthCandle {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

/**
 * Returns null when healthy, otherwise a health code.
 * Source of truth for Angel and CSV — Home.tsx must not duplicate this logic.
 */
export function checkDataHealth(data: readonly HealthCandle[]): string | null {
  if (!Array.isArray(data) || data.length < 200) return "insufficient_bars"
  for (const row of data) {
    if ([row.o, row.h, row.l, row.c].some((v) => Number.isNaN(v as number))) return "nan_ohlc"
    if (row.h < row.l || row.h < row.o || row.h < row.c || row.l > row.o || row.l > row.c) return "invalid_ohlc"
    if (typeof row.t === "number" && row.t > Date.now()) return "future_timestamp"
  }
  return null
}

/**
 * Resample to the requested interval. ONE_MINUTE is the canonical ingest;
 * other intervals would aggregate here. For now the path is identity+sort,
 * shared by CSV and Angel so deep-equal holds.
 */
export function resampleCandles(data: readonly HealthCandle[], _interval: string): HealthCandle[] {
  return [...data].sort((a, b) => a.t - b.t)
}
