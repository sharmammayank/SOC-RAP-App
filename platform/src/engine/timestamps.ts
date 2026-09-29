import { zonedToUtc } from "./tz";

const TS_MIN = Date.UTC(2000, 0, 1),
  TS_MAX = Date.UTC(2100, 0, 1);

export interface ParsedTs {
  /** null = empty, NaN = unreadable */
  ms: number | null;
  form: string;
}

/**
 * Detects the timestamp form per value: epoch s / ms / µs / ns, Excel serial dates, ISO-8601 with or without a zone.
 * Text without a zone is read in `naiveTz`. Values outside 2000–2100 are treated as unreadable.
 */
export function parseTs(v: unknown, naiveTz = "UTC"): ParsedTs {
  if (v === null || v === undefined || v === "") return { ms: null, form: "empty" };
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isNaN(t) ? { ms: NaN, form: "invalid" } : { ms: t, form: "Excel date" };
  }
  let n: number | null = null;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) n = Number(v);
  if (n !== null) {
    if (!Number.isFinite(n)) return { ms: NaN, form: "invalid" };
    const digits = String(Math.floor(Math.abs(n))).length;
    let ms: number | null = null,
      form = "";
    if (n > 20000 && n < 80000) {
      ms = Math.round((n - 25569) * 86400000);
      form = "Excel serial";
    } else if (digits >= 9 && digits <= 10) {
      ms = n * 1000;
      form = "epoch seconds";
    } else if (digits >= 12 && digits <= 13) {
      ms = n;
      form = "epoch ms";
    } else if (digits >= 15 && digits <= 16) {
      ms = Math.round(n / 1000);
      form = "epoch µs";
    } else if (digits >= 18 && digits <= 19) {
      ms = Math.round(n / 1e6);
      form = "epoch ns";
    }
    if (ms === null || ms < TS_MIN || ms > TS_MAX) return { ms: NaN, form: "invalid" };
    return { ms, form };
  }
  const s = String(v).trim().slice(0, 64);
  const naive = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/);
  let ms: number, form: string;
  if (naive) {
    const [, Y, M, D, h, mi, se, frac] = naive;
    ms = zonedToUtc(+Y, +M, +D, +h, +mi, +(se || 0), frac ? +(frac + "00").slice(0, 3) : 0, naiveTz);
    form = `date text (no zone, read as ${naiveTz})`;
  } else {
    ms = Date.parse(s);
    form = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? "ISO-8601 with zone" : "date text";
  }
  if (Number.isNaN(ms) || ms < TS_MIN || ms > TS_MAX) return { ms: NaN, form: "invalid" };
  return { ms, form };
}
