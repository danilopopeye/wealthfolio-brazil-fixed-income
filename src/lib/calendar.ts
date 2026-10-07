/**
 * Business-day calendar for the Brazilian CDI market — TypeScript port of
 * api/calendar.go (fixture-validated). Weekends plus national/ANBIMA banking
 * holidays computed from the holiday law; the empirically discovered
 * convention is baked in: carnaval is Monday+Tuesday, Ash Wednesday is a
 * business day (validated against SGS series 12 for 2023-2026).
 *
 * Dates are ISO strings ('YYYY-MM-DD'); all arithmetic is UTC.
 */

function easter(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86400000);

function nationalHolidays(year: number): Set<string> {
  const e = easter(year);
  const md = (d: Date) => d.toISOString().slice(5, 10);
  const fixed = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '12-25'];
  if (year >= 2024) fixed.push('11-20'); // Lei 14.759/2023
  const set = new Set(fixed.map((x) => `${year}-${x}`));
  set.add(`${year}-${md(addDays(e, -48))}`); // carnaval Monday
  set.add(`${year}-${md(addDays(e, -47))}`); // carnaval Tuesday
  set.add(`${year}-${md(addDays(e, -2))}`); // Sexta-feira Santa
  set.add(`${year}-${md(addDays(e, 60))}`); // Corpus Christi
  return set;
}

const byYear = new Map<number, Set<string>>();

function isHoliday(isoDate: string): boolean {
  const year = Number(isoDate.slice(0, 4));
  let set = byYear.get(year);
  if (!set) {
    set = nationalHolidays(year);
    byYear.set(year, set);
  }
  return set.has(isoDate);
}

function parseIso(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00Z`);
}

export function isBusinessDay(isoDate: string): boolean {
  const dow = parseIso(isoDate).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !isHoliday(isoDate);
}

export function nextBusinessDay(isoDate: string): string {
  let d = addDays(parseIso(isoDate), 1);
  while (!isBusinessDay(iso(d))) d = addDays(d, 1);
  return iso(d);
}

export function prevBusinessDay(isoDate: string): string {
  let d = addDays(parseIso(isoDate), -1);
  while (!isBusinessDay(iso(d))) d = addDays(d, -1);
  return iso(d);
}

export function firstBusinessDayOnOrAfter(isoDate: string): string {
  let d = parseIso(isoDate);
  while (!isBusinessDay(iso(d))) d = addDays(d, 1);
  return iso(d);
}

/** Counts business days in [a, b) — ISO date strings. */
export function businessDaysBetween(a: string, b: string): number {
  if (a >= b) return 0;
  let n = 0;
  let d = firstBusinessDayOnOrAfter(a);
  while (d < b) {
    n++;
    d = nextBusinessDay(d);
  }
  return n;
}

/** Current date in America/Sao_Paulo (fixed UTC-3, no DST since 2019). */
export function todaySaoPaulo(): string {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}
