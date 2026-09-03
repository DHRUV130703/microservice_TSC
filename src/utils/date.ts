import { env } from '../config/env.js';

export type PeriodAnchor = 'day' | 'week' | 'month';

export interface DateWindow {
  /** Inclusive start, ISO `YYYY-MM-DD`. */
  from: string;
  /** Inclusive end, ISO `YYYY-MM-DD`. */
  to: string;
  /** Inclusive day count, so a caller can see how wide the window really is. */
  days: number;
  timezone: string;
  /**
   * Where the bounds came from. `custom` means the caller supplied them, in
   * which case the refresh-cadence fields below do not apply — the window is
   * fixed by the request, not by the clock.
   */
  source: 'default' | 'custom';
  /** Configured window length. Only meaningful when `source` is `default`. */
  months?: number;
  mode?: 'calendar_months' | 'rolling';
  /** How often the default window moves. Only set when `source` is `default`. */
  anchor?: PeriodAnchor;
  /** When the default window next moves. Only set when `source` is `default`. */
  nextRolloverOn?: string;
}

/** Inclusive number of days between two ISO dates. */
export function daysBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = toIso.split('-').map(Number) as [number, number, number];
  const ms = Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd);
  return Math.floor(ms / 86_400_000) + 1;
}

/** True for a well-formed, real calendar date in `YYYY-MM-DD` form. */
export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** "Today" in the configured IANA timezone, as {y, m, d}. */
export function todayInTimezone(timezone: string, now: Date = new Date()): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

const pad = (n: number): string => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Subtract whole months from a Y-M-D triple, clamping the day to the target month. */
function subtractMonths(y: number, m: number, d: number, months: number): { y: number; m: number; d: number } {
  const zeroBased = y * 12 + (m - 1) - months;
  const ny = Math.floor(zeroBased / 12);
  const nm = (zeroBased % 12) + 1;
  return { y: ny, m: nm, d: Math.min(d, daysInMonth(ny, nm)) };
}

/** Day of week for a Y-M-D triple: 0=Sunday .. 6=Saturday. */
function dayOfWeek(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDays(y: number, m: number, d: number, delta: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * Snaps "today" back to the anchor boundary, so the window — and therefore the
 * cache key — only moves once per anchor interval.
 *
 *  day   -> today
 *  week  -> the most recent Sunday (today itself when today is a Sunday)
 *  month -> the last day of the previous month
 */
export function anchorDate(
  today: { y: number; m: number; d: number },
  anchor: PeriodAnchor,
): { y: number; m: number; d: number } {
  switch (anchor) {
    case 'day':
      return today;
    case 'week':
      return addDays(today.y, today.m, today.d, -dayOfWeek(today.y, today.m, today.d));
    case 'month':
      return addDays(today.y, today.m, 1, -1);
  }
}

/** The date on which the anchored window will next move. */
function nextRollover(anchored: { y: number; m: number; d: number }, anchor: PeriodAnchor): { y: number; m: number; d: number } {
  switch (anchor) {
    case 'day':
      return addDays(anchored.y, anchored.m, anchored.d, 1);
    case 'week':
      return addDays(anchored.y, anchored.m, anchored.d, 7);
    case 'month': {
      // First day of the month after the one that contains `anchored`, plus a month.
      const firstOfNext = { y: anchored.y, m: anchored.m, d: 1 };
      const shifted = firstOfNext.m === 12 ? { y: firstOfNext.y + 1, m: 1, d: 1 } : { y: firstOfNext.y, m: firstOfNext.m + 1, d: 1 };
      return addDays(shifted.y, shifted.m, shifted.d, 0);
    }
  }
}

/**
 * Resolves the reporting window dynamically from the current date — never hardcoded.
 *
 * calendar_months (default): whole calendar months, `months` of them, ending with
 *   the current (partial) month. On 2026-08-31 with months=6 this yields
 *   2026-03-01 .. 2026-08-31, matching the documented API contract.
 *
 * rolling: exactly `months` months back from today.
 *   On 2026-08-31 with months=6 this yields 2026-02-28 .. 2026-08-31.
 */
export function resolveDateWindow(
  now: Date = new Date(),
  months: number = env.METRICS_PERIOD_MONTHS,
  mode: 'calendar_months' | 'rolling' = env.METRICS_PERIOD_MODE,
  timezone: string = env.METRICS_TIMEZONE,
  anchor: PeriodAnchor = env.METRICS_PERIOD_ANCHOR,
): DateWindow {
  const today = todayInTimezone(timezone, now);

  // Both bounds are derived from the ANCHORED date, not from today, so the
  // window stays internally consistent (a week-anchored window still spans
  // exactly `months` months) and only changes once per anchor interval.
  const end = anchorDate(today, anchor);
  const to = iso(end.y, end.m, end.d);

  let from: string;
  if (mode === 'calendar_months') {
    const start = subtractMonths(end.y, end.m, 1, months - 1);
    from = iso(start.y, start.m, 1);
  } else {
    const start = subtractMonths(end.y, end.m, end.d, months);
    from = iso(start.y, start.m, start.d);
  }

  const rollover = nextRollover(end, anchor);

  return {
    from,
    to,
    days: daysBetween(from, to),
    timezone,
    source: 'default',
    months,
    mode,
    anchor,
    nextRolloverOn: iso(rollover.y, rollover.m, rollover.d),
  };
}

/**
 * Builds a window from caller-supplied bounds, filling in whichever side was
 * omitted from the configured default. Both bounds are inclusive and are
 * interpreted as plain dates in `timezone`, exactly as the default window is,
 * so a custom range and the default range are measured the same way.
 */
export function resolveRequestedWindow(
  requested: { from?: string; to?: string },
  now: Date = new Date(),
  timezone: string = env.METRICS_TIMEZONE,
): DateWindow {
  if (!requested.from && !requested.to) return resolveDateWindow(now);

  const fallback = resolveDateWindow(now);
  const to = requested.to ?? fallback.to;

  let from: string;
  if (requested.from) {
    from = requested.from;
  } else {
    // Only `to` was given: keep the configured span, measured back from it.
    const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
    const months = env.METRICS_PERIOD_MONTHS;
    const start =
      env.METRICS_PERIOD_MODE === 'calendar_months'
        ? { ...subtractMonths(ty, tm, 1, months - 1), d: 1 }
        : subtractMonths(ty, tm, td, months);
    from = iso(start.y, start.m, start.d);
  }

  return { from, to, days: daysBetween(from, to), timezone, source: 'custom' };
}

/**
 * Shard suffixes covering the window, for wildcard `_TABLE_SUFFIX` pruning.
 * Returns the inclusive [min, max] suffix strings in the given format.
 */
export function suffixRange(
  window: Pick<DateWindow, 'from' | 'to'>,
  format: 'YYYYMM' | 'YYYY_MM' | 'YYYYMMDD' | 'YYYY_MM_DD' | 'YYYY',
): { min: string; max: string } {
  const fmt = (isoDate: string): string => {
    const [y, m, d] = isoDate.split('-') as [string, string, string];
    switch (format) {
      case 'YYYY':
        return y;
      case 'YYYYMM':
        return `${y}${m}`;
      case 'YYYY_MM':
        return `${y}_${m}`;
      case 'YYYYMMDD':
        return `${y}${m}${d}`;
      case 'YYYY_MM_DD':
        return `${y}_${m}_${d}`;
    }
  };
  return { min: fmt(window.from), max: fmt(window.to) };
}
