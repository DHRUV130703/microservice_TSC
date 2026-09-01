import { describe, expect, it } from 'vitest';
import { resolveDateWindow, suffixRange, todayInTimezone } from '../src/utils/date.js';

describe('last-six-month date filtering', () => {
  it('derives the calendar-month window documented in the API contract', () => {
    // 2026-08-31 12:00 IST
    const now = new Date('2026-08-31T06:30:00.000Z');
    const window = resolveDateWindow(now, 6, 'calendar_months', 'Asia/Kolkata');
    expect(window).toMatchObject({ from: '2026-03-01', to: '2026-08-31', months: 6, mode: 'calendar_months' });
  });

  it('derives the rolling window exactly six months back', () => {
    const now = new Date('2026-08-31T06:30:00.000Z');
    const window = resolveDateWindow(now, 6, 'rolling', 'Asia/Kolkata');
    expect(window).toMatchObject({ from: '2026-02-28', to: '2026-08-31' });
  });

  it('crosses the year boundary correctly', () => {
    const now = new Date('2026-02-15T06:30:00.000Z');
    expect(resolveDateWindow(now, 6, 'calendar_months', 'Asia/Kolkata').from).toBe('2025-09-01');
    expect(resolveDateWindow(now, 6, 'rolling', 'Asia/Kolkata').from).toBe('2025-08-15');
  });

  it('clamps the day when the target month is shorter (rolling)', () => {
    // 31 Aug minus 6 months lands in February, which has no 31st.
    const now = new Date('2027-08-31T06:30:00.000Z');
    expect(resolveDateWindow(now, 6, 'rolling', 'Asia/Kolkata').from).toBe('2027-02-28');
    // Leap year February.
    const leap = new Date('2028-08-31T06:30:00.000Z');
    expect(resolveDateWindow(leap, 6, 'rolling', 'Asia/Kolkata').from).toBe('2028-02-29');
  });

  it('is never hardcoded: the window moves with the clock', () => {
    const a = resolveDateWindow(new Date('2026-08-31T06:30:00.000Z'), 6, 'calendar_months', 'Asia/Kolkata');
    const b = resolveDateWindow(new Date('2026-09-01T06:30:00.000Z'), 6, 'calendar_months', 'Asia/Kolkata');
    expect(a.from).not.toBe(b.from);
    expect(b).toMatchObject({ from: '2026-04-01', to: '2026-09-01' });
  });

  it('resolves "today" in the configured timezone, not UTC', () => {
    // 2026-08-31T20:00Z is already 2026-09-01 in Asia/Kolkata (+05:30).
    const now = new Date('2026-08-31T20:00:00.000Z');
    expect(todayInTimezone('Asia/Kolkata', now)).toEqual({ y: 2026, m: 9, d: 1 });
    expect(todayInTimezone('UTC', now)).toEqual({ y: 2026, m: 8, d: 31 });
  });

  it('computes shard suffix ranges for wildcard pruning', () => {
    const window = { from: '2026-03-01', to: '2026-08-31' };
    expect(suffixRange(window, 'YYYY_MM')).toEqual({ min: '2026_03', max: '2026_08' });
    expect(suffixRange(window, 'YYYYMM')).toEqual({ min: '202603', max: '202608' });
    expect(suffixRange(window, 'YYYYMMDD')).toEqual({ min: '20260301', max: '20260831' });
    expect(suffixRange(window, 'YYYY')).toEqual({ min: '2026', max: '2026' });
  });
});

describe('period anchoring — how often BigQuery is actually queried', () => {
  const at = (iso: string, anchor: 'day' | 'week' | 'month') =>
    resolveDateWindow(new Date(`${iso}T06:30:00.000Z`), 6, 'calendar_months', 'Asia/Kolkata', anchor);

  it('day anchor: the window moves every day', () => {
    expect(at('2026-08-26', 'day').to).toBe('2026-08-26');
    expect(at('2026-08-27', 'day').to).toBe('2026-08-27');
    expect(at('2026-08-26', 'day').nextRolloverOn).toBe('2026-08-27');
  });

  it('week anchor: the window is identical every day of the week', () => {
    // 2026-08-23 is a Sunday; Mon 24 .. Sat 29 must all resolve to it.
    const days = ['2026-08-23', '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29'];
    const windows = days.map((d) => at(d, 'week'));
    for (const w of windows) expect(w.to).toBe('2026-08-23');
    // One cache key for the whole week => one BigQuery job per pincode per week.
    expect(new Set(windows.map((w) => `${w.from}::${w.to}`)).size).toBe(1);
  });

  it('week anchor: the window moves on the next Sunday, and says when', () => {
    expect(at('2026-08-26', 'week').nextRolloverOn).toBe('2026-08-30');
    expect(at('2026-08-30', 'week').to).toBe('2026-08-30');
    expect(at('2026-08-30', 'week').nextRolloverOn).toBe('2026-09-06');
  });

  it('week anchor keeps the window exactly `months` long (derived from the anchor, not today)', () => {
    // On 2026-09-02 the anchor is Sunday 2026-08-30, so the window must be
    // March..August — not April..August, which anchoring from `today` would give.
    const w = at('2026-09-02', 'week');
    expect(w).toMatchObject({ from: '2026-03-01', to: '2026-08-30', months: 6 });
  });

  it('month anchor: window ends on the last day of the previous month', () => {
    const w = at('2026-09-15', 'month');
    expect(w.to).toBe('2026-08-31');
    expect(w.from).toBe('2026-03-01');
    expect(w.nextRolloverOn).toBe('2026-09-01');
  });

  it('month anchor: stable across the whole month', () => {
    const a = at('2026-09-02', 'month');
    const b = at('2026-09-28', 'month');
    expect(`${a.from}::${a.to}`).toBe(`${b.from}::${b.to}`);
  });

  it('week anchor works across a year boundary', () => {
    // 2027-01-03 is a Sunday.
    expect(at('2027-01-06', 'week').to).toBe('2027-01-03');
    expect(at('2027-01-01', 'week').to).toBe('2026-12-27');
  });

  it('reports the anchor so consumers know the data cadence', () => {
    expect(at('2026-08-26', 'week').anchor).toBe('week');
  });
});
