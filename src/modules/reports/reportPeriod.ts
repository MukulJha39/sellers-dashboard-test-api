import { AppError } from '../../utils/AppError';

/**
 * The time windows a report can cover, and how they map onto real instants.
 *
 * A merchant's "today" starts at midnight where the shop is, not at midnight UTC, so
 * every boundary is computed in a time zone. The app sends its own (`tz`); without one
 * the business default below is used, which suits the merchants the product serves.
 */

export const DEFAULT_REPORT_TIMEZONE = 'Asia/Kolkata';

export const REPORT_PERIODS = [
  'today',
  'yesterday',
  'last_7_days',
  'last_30_days',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'this_year',
  'custom',
] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

/** The longest custom range a report accepts, so one request cannot scan years of data. */
export const MAX_CUSTOM_RANGE_DAYS = 731;

export type BucketSize = 'day' | 'month';

export interface ResolvedPeriod {
  period: ReportPeriod;
  timezone: string;
  /** First instant inside the window. */
  start: Date;
  /** First instant after the window. Queries use `< end`. */
  end: Date;
  /** Calendar days, inclusive, as the merchant reads them: `YYYY-MM-DD`. */
  from: string;
  to: string;
  days: number;
  /** How the window's chart is split: by day up to two months, by month beyond. */
  bucket: BucketSize;
  /** The window of the same length just before this one, for comparison. */
  previous: { start: Date; end: Date; from: string; to: string };
}

interface CalendarDay {
  y: number;
  m: number; // 1-12
  d: number;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The calendar day an instant falls on, in a time zone. */
function dayIn(instant: Date, tz: string): CalendarDay {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)!.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** How far a zone is ahead of UTC at an instant, in milliseconds. */
function offsetAt(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant a calendar day starts, in a time zone. */
export function startOfDayIn(day: CalendarDay, tz: string): Date {
  const guess = Date.UTC(day.y, day.m - 1, day.d);
  let instant = guess - offsetAt(new Date(guess), tz);
  // Checked once more, for a day on which the offset changes (daylight saving).
  instant = guess - offsetAt(new Date(instant), tz);
  return new Date(instant);
}

/** Calendar arithmetic, done in UTC so it never depends on the server's zone. */
function addDays(day: CalendarDay, days: number): CalendarDay {
  const date = new Date(Date.UTC(day.y, day.m - 1, day.d + days));
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

function addMonths(day: CalendarDay, months: number): CalendarDay {
  const date = new Date(Date.UTC(day.y, day.m - 1 + months, 1));
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: 1 };
}

function daysBetween(from: CalendarDay, to: CalendarDay): number {
  return Math.round(
    (Date.UTC(to.y, to.m - 1, to.d) - Date.UTC(from.y, from.m - 1, from.d)) / 86_400_000,
  );
}

export function formatDay(day: CalendarDay): string {
  return `${day.y}-${String(day.m).padStart(2, '0')}-${String(day.d).padStart(2, '0')}`;
}

export function parseDay(text: string): CalendarDay | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const day = { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
  const check = new Date(Date.UTC(day.y, day.m - 1, day.d));
  if (check.getUTCMonth() + 1 !== day.m || check.getUTCDate() !== day.d) return null;
  return day;
}

/** The inclusive first and last calendar day of a named period. */
function calendarRange(
  period: ReportPeriod,
  today: CalendarDay,
  custom: { from?: string; to?: string },
): { first: CalendarDay; last: CalendarDay; previous?: { first: CalendarDay; last: CalendarDay } } {
  switch (period) {
    case 'today':
      return { first: today, last: today };
    case 'yesterday': {
      const day = addDays(today, -1);
      return { first: day, last: day };
    }
    case 'last_7_days':
      return { first: addDays(today, -6), last: today };
    case 'last_30_days':
      return { first: addDays(today, -29), last: today };
    case 'this_week':
    case 'last_week': {
      // Weeks start on Monday.
      const weekday = new Date(Date.UTC(today.y, today.m - 1, today.d)).getUTCDay();
      const monday = addDays(today, -((weekday + 6) % 7));
      return period === 'this_week'
        ? { first: monday, last: today }
        : { first: addDays(monday, -7), last: addDays(monday, -1) };
    }
    case 'this_month': {
      const first = { ...today, d: 1 };
      // Compared with the same days of last month, not the whole of it.
      const prevFirst = addMonths(first, -1);
      const prevMonthEnd = addDays(first, -1);
      const prevLast =
        today.d <= prevMonthEnd.d ? { ...prevFirst, d: today.d } : prevMonthEnd;
      return { first, last: today, previous: { first: prevFirst, last: prevLast } };
    }
    case 'last_month': {
      const first = addMonths({ ...today, d: 1 }, -1);
      const last = addDays({ ...today, d: 1 }, -1);
      const prevFirst = addMonths(first, -1);
      return { first, last, previous: { first: prevFirst, last: addDays(first, -1) } };
    }
    case 'this_year': {
      const first = { y: today.y, m: 1, d: 1 };
      const prevFirst = { y: today.y - 1, m: 1, d: 1 };
      const prevLast = addDays(prevFirst, daysBetween(first, today));
      return { first, last: today, previous: { first: prevFirst, last: prevLast } };
    }
    case 'custom': {
      const first = custom.from ? parseDay(custom.from) : null;
      const last = custom.to ? parseDay(custom.to) : null;
      if (!first || !last) {
        throw AppError.validation('Please correct the highlighted fields.', [
          { field: first ? 'to' : 'from', message: 'Choose both dates, as YYYY-MM-DD.' },
        ]);
      }
      if (daysBetween(first, last) < 0) {
        throw AppError.validation('Please correct the highlighted fields.', [
          { field: 'to', message: 'The end date must be on or after the start date.' },
        ]);
      }
      if (daysBetween(first, last) + 1 > MAX_CUSTOM_RANGE_DAYS) {
        throw AppError.validation('Please correct the highlighted fields.', [
          { field: 'to', message: `Choose a range of at most ${MAX_CUSTOM_RANGE_DAYS} days.` },
        ]);
      }
      return { first, last };
    }
  }
}

export function resolvePeriod(input: {
  period?: ReportPeriod;
  from?: string;
  to?: string;
  tz?: string;
  now?: Date;
}, fallback: ReportPeriod = 'this_month'): ResolvedPeriod {
  const timezone = input.tz && isValidTimezone(input.tz) ? input.tz : DEFAULT_REPORT_TIMEZONE;
  // Sending dates without naming a period means a custom range.
  const period = input.period ?? (input.from || input.to ? 'custom' : fallback);
  const today = dayIn(input.now ?? new Date(), timezone);

  const range = calendarRange(period, today, { from: input.from, to: input.to });
  const days = daysBetween(range.first, range.last) + 1;
  const previous = range.previous ?? {
    first: addDays(range.first, -days),
    last: addDays(range.first, -1),
  };

  return {
    period,
    timezone,
    start: startOfDayIn(range.first, timezone),
    end: startOfDayIn(addDays(range.last, 1), timezone),
    from: formatDay(range.first),
    to: formatDay(range.last),
    days,
    bucket: days <= 62 ? 'day' : 'month',
    previous: {
      start: startOfDayIn(previous.first, timezone),
      end: startOfDayIn(addDays(previous.last, 1), timezone),
      from: formatDay(previous.first),
      to: formatDay(previous.last),
    },
  };
}

/** Every bucket key in the window, so a chart has a point for days with no sales. */
export function bucketKeys(period: ResolvedPeriod): string[] {
  const first = parseDay(period.from)!;
  const last = parseDay(period.to)!;
  const keys: string[] = [];
  if (period.bucket === 'day') {
    for (let day = first; daysBetween(day, last) >= 0; day = addDays(day, 1)) keys.push(formatDay(day));
  } else {
    for (let month = { ...first, d: 1 }; daysBetween(month, last) >= 0; month = addMonths(month, 1)) {
      keys.push(formatDay(month).slice(0, 7));
    }
  }
  return keys;
}

/** The `$dateToString` expression that names a date's bucket, in the report's zone. */
export function bucketExpression(field: string, period: ResolvedPeriod): Record<string, unknown> {
  return {
    $dateToString: {
      format: period.bucket === 'day' ? '%Y-%m-%d' : '%Y-%m',
      date: field,
      timezone: period.timezone,
    },
  };
}

/** Percentage change from `previous` to `current`, or null when there is nothing to compare. */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

/** Whole days from one instant to another, for "pending for N days". */
export function wholeDaysSince(instant: Date | null | undefined, now: Date): number | null {
  if (!instant) return null;
  return Math.max(0, Math.floor((now.getTime() - instant.getTime()) / 86_400_000));
}

/** What a client shows above a report: the window it covers. */
export function presentPeriod(period: ResolvedPeriod) {
  return {
    period: period.period,
    from: period.from,
    to: period.to,
    days: period.days,
    timezone: period.timezone,
    bucket: period.bucket,
    previous: { from: period.previous.from, to: period.previous.to },
  };
}
