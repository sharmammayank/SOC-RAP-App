/* Time-zone helpers built on Intl (IANA zones, DST-aware). No dependency. */

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Offsets are cached per zone per 15-minute bucket; every real zone transition lands on a 15-minute boundary.
const offCache = new Map<string, Map<number, number>>();
const BUCKET = 15 * 60000;
/** Minutes to add to UTC to get local wall time at instant `ms`. */
export function offsetMinutes(tz: string, ms: number): number {
  if (tz === "UTC" || tz === "Etc/UTC") return 0;
  let m = offCache.get(tz);
  if (!m) offCache.set(tz, (m = new Map()));
  const b = Math.floor(ms / BUCKET);
  let v = m.get(b);
  if (v === undefined) {
    const p: Record<string, number> = {};
    for (const x of fmt(tz).formatToParts(new Date(b * BUCKET))) if (x.type !== "literal") p[x.type] = Number(x.value);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    v = Math.round((asUtc - b * BUCKET) / 60000);
    if (m.size > 200000) m.clear();
    m.set(b, v);
  }
  return v;
}

export interface ZonedParts {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  mi: number;
  /** 0 = Monday … 6 = Sunday */
  wd: number;
}
export function zoned(ms: number, tz: string): ZonedParts {
  const t = new Date(ms + offsetMinutes(tz, ms) * 60000);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), wd: (t.getUTCDay() + 6) % 7 };
}

/** UTC instant for a wall-clock time in `tz`. Nonexistent times (DST gap) resolve forward. */
export function zonedToUtc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, msec = 0, tz = "UTC"): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s, msec);
  let guess = wall - offsetMinutes(tz, wall) * 60000;
  const o2 = offsetMinutes(tz, guess);
  guess = wall - o2 * 60000;
  return guess;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export function ymdOf(ms: number, tz: string): string {
  const z = zoned(ms, tz);
  return `${z.y}-${pad(z.mo)}-${pad(z.d)}`;
}
export function ymdToUtc(ymd: string, tz: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return zonedToUtc(y, m, d, 0, 0, 0, 0, tz);
}
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function fmtInTz(ms: number | null | undefined, tz: string, withSeconds = false): string {
  if (ms == null || Number.isNaN(ms)) return "—";
  const z = new Date(ms + offsetMinutes(tz, ms) * 60000).toISOString();
  return z.slice(0, withSeconds ? 19 : 16).replace("T", " ");
}
export function tzAbbrev(tz: string): string {
  if (tz === "UTC" || tz === "Etc/UTC") return "UTC";
  if (tz === "Asia/Kolkata" || tz === "Asia/Calcutta") return "IST";
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date());
    return p.find((x) => x.type === "timeZoneName")?.value ?? tz;
  } catch {
    return tz;
  }
}
