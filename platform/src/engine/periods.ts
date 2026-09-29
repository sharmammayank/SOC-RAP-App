import { addDays, ymdToUtc } from "./tz";

export type Cadence = "weekly" | "monthly" | "custom";

export interface Period {
  cadence: Cadence;
  start: string; // YYYY-MM-DD inclusive
  end: string; // YYYY-MM-DD inclusive
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTH_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function monthBounds(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  return [new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10), new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)];
}
export function mondayOf(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const wd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDays(ymd, -wd);
}
/** Boundaries auto-filled from the cadence (spec §7.3 step 1). */
export function periodFor(cadence: Cadence, anchor: string): Period {
  if (cadence === "monthly") {
    const [s, e] = monthBounds(anchor.slice(0, 7));
    return { cadence, start: s, end: e };
  }
  if (cadence === "weekly") {
    const s = mondayOf(anchor);
    return { cadence, start: s, end: addDays(s, 6) };
  }
  return { cadence, start: anchor, end: anchor };
}
/** [from, to) in UTC ms for a period counted in `tz`. */
export function periodRange(p: { start: string; end: string }, tz: string): { from: number; to: number } {
  return { from: ymdToUtc(p.start, tz), to: ymdToUtc(addDays(p.end, 1), tz) };
}
export function periodDays(p: { start: string; end: string }): number {
  return Math.round((Date.parse(addDays(p.end, 1)) - Date.parse(p.start)) / 86400000);
}
/** Immediately preceding period of the same cadence (spec §6.2). */
export function previousPeriod(p: Period): Period {
  if (p.cadence === "monthly") {
    const [y, m] = p.start.split("-").map(Number);
    const pm = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
    const [s, e] = monthBounds(pm);
    return { cadence: p.cadence, start: s, end: e };
  }
  const len = periodDays(p);
  return { cadence: p.cadence, start: addDays(p.start, -len), end: addDays(p.start, -1) };
}
/** Same period one year earlier. */
export function priorYearPeriod(p: Period): Period {
  const shift = (ymd: string) => `${Number(ymd.slice(0, 4)) - 1}${ymd.slice(4)}`.replace(/-02-29$/, "-02-28");
  if (p.cadence === "monthly") {
    const [s, e] = monthBounds(shift(p.start).slice(0, 7));
    return { ...p, start: s, end: e };
  }
  return { ...p, start: shift(p.start), end: shift(p.end) };
}
/** A weekly period must be seven days and a monthly one a calendar month (spec §4.4). */
export function periodError(p: Period): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.start) || !/^\d{4}-\d{2}-\d{2}$/.test(p.end)) return "Pick a start and end date.";
  if (p.end < p.start) return "The end date is before the start date.";
  if (p.cadence === "weekly" && periodDays(p) !== 7) return "A weekly period must be exactly seven days.";
  if (p.cadence === "monthly") {
    const [s, e] = monthBounds(p.start.slice(0, 7));
    if (p.start !== s || p.end !== e) return "A monthly period must cover one calendar month.";
  }
  if (periodDays(p) > 366) return "A period can't be longer than a year.";
  return null;
}
export function fmtYmd(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${d} ${MON[m - 1]} ${y}`;
}
export function periodLabel(p: { start: string; end: string; cadence: string }): string {
  const [y, m] = p.start.split("-").map(Number);
  if (p.cadence === "monthly") return `${MONTH_FULL[m - 1]} ${y}`;
  if (p.start === p.end) return fmtYmd(p.start);
  return `${fmtYmd(p.start)} – ${fmtYmd(p.end)}`;
}
export function shortPeriodLabel(p: { start: string; end: string; cadence: string }): string {
  const [y, m] = p.start.split("-").map(Number);
  if (p.cadence === "monthly") return `${MON[m - 1]}-${String(y).slice(2)}`;
  const [, sm, sd] = p.start.split("-").map(Number);
  const [, em, ed] = p.end.split("-").map(Number);
  return `${sd} ${MON[sm - 1]}–${ed} ${MON[em - 1]}`;
}
export { MON };
