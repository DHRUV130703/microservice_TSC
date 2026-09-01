import { env } from '../config/env.js';

export type PeriodAnchor = 'day' | 'week' | 'month';

export interface DateWindow {
  /** Inclusive start, ISO `YYYY-MM-DD`. */
  from: string;
  /** Inclusive end, ISO `YYYY-MM-DD`. */
  to: string;
  months: number;
  mode: 'calendar_months' | 'rolling';
  /** How often the window is allowed to move. */
  anchor: PeriodAnchor;
  timezone: string;
  /** ISO date at which this window becomes stale and BigQuery is queried again. */
  nextRolloverOn: string;
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
    months,
    mode,
    anchor,
    timezone,
    nextRolloverOn: iso(rollover.y, rollover.m, rollover.d),
  };
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
