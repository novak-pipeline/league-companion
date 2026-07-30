/**
 * Number formatting and the shared "is this good or bad" scale.
 *
 * Every rate in the app is coloured by the same thresholds so the user only has
 * to learn them once: green means above average, red means below, grey means
 * the difference is not worth reacting to.
 */

export type Tone = 'good' | 'neutral' | 'bad';

/** Below 48% is bad, 48-52% is noise, above 52% is good. */
export function winRateTone(winRate: number): Tone {
  if (!Number.isFinite(winRate)) return 'neutral';
  if (winRate < 48) return 'bad';
  if (winRate > 52) return 'good';
  return 'neutral';
}

export function round(value: number, places = 1): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** `54.2%`, with a fixed number of decimals so columns stay aligned. */
export function formatPercent(value: number, places = 1): string {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(places)}%`;
}

/** Thousands separators, so a 12,480-game sample reads at a glance. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString();
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** Seconds -> `M:SS`, clamped at zero. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
