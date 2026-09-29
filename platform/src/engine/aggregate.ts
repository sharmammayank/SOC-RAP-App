import type { EngineSettings, Metric, MetricResult, Priority, SlaPriority, Targets } from "./types";
import { ALL_PRIORITIES, METRIC_KEYS, PRIORITIES } from "./types";
import { ymdOf, zoned } from "./tz";

/** The fields aggregation needs. Satisfied by engine output and by rows loaded from `case_derived`. */
export interface AggCase {
  rowNo?: number;
  caseId: string;
  title: string;
  category: string;
  subcategory: string;
  bucket: string;
  priority: Priority | null;
  ts: { createdAt: number | null };
  disposition: string;
  closeReason: string;
  rootCause: string;
  assignee: string;
  isOpen: boolean;
  ev: Record<Metric, MetricResult>;
}

/** Counters keyed by file-derived text use null-prototype objects, so keys like "__proto__" are plain data. */
export type Counts = Record<string, number>;
export const dict = (): Counts => Object.create(null);
const bump = (o: Counts, k: string, n = 1) => {
  o[k] = (o[k] || 0) + n;
};

export interface SlaCell {
  met: number;
  notMet: number;
  pending: number;
  na: number;
  err: number;
  zero: number;
  n: number;
  pct: number | null;
  target: number | null;
  status: "ok" | "bad" | "none";
  /** Points above (+) or below (−) target. */
  variance: number | null;
  mean: number | null;
  median: number | null;
  p95: number | null;
  worst: { caseId: string; title: string; el: number }[];
}

export interface Aggregate {
  from: number;
  to: number;
  total: number;
  evaluable: number;
  byPrio: Record<Priority, number>;
  sla: Record<SlaPriority, Record<Metric, SlaCell>>;
  overall: Record<Metric, SlaCell>;
  bucket: Counts;
  category: Counts;
  disp: Counts;
  closeR: Counts;
  /** Ordered [day or hour key, disposition counts]. Keys are YYYY-MM-DD, or HH:00 for periods of two days or less. */
  daily: [string, Counts][];
  auto: number;
  tp: number;
  open: number;
  uncategorized: number;
  simulation: number;
  tier12: number;
  tier3: number;
  /** Alert title → 24 hourly counts (display time zone). */
  heat: Record<string, number[]>;
  dispByTitle: Record<string, Counts>;
}

const DAY = 86400000;
export const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
export function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q,
    lo = Math.floor(pos),
    hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const emptyCell = (): SlaCell & { vals: number[] } => ({
  met: 0,
  notMet: 0,
  pending: 0,
  na: 0,
  err: 0,
  zero: 0,
  n: 0,
  pct: null,
  target: null,
  status: "none",
  variance: null,
  mean: null,
  median: null,
  p95: null,
  worst: [],
  vals: [],
});

export function closeReasonBucket(c: Pick<AggCase, "isOpen" | "closeReason">): string {
  if (c.isOpen) return "Pending";
  return ({ Malicious: "Malicious", NotMalicious: "Non-Malicious", "Not Malicious": "Non-Malicious", Maintenance: "Maintenance" } as Record<string, string>)[c.closeReason] || "Other";
}

/**
 * Compliance % = MET / (MET + NOT MET) × 100 per metric per priority (spec §5.3).
 * NA, PENDING and DATA ERROR are excluded from both numerator and denominator.
 */
export function aggregate(cases: AggCase[], o: { targets: Targets | null; from: number; to: number; settings: Pick<EngineSettings, "periodTz" | "displayTz"> }): Aggregate {
  const byPrio = {} as Record<Priority, number>;
  for (const p of ALL_PRIORITIES) byPrio[p] = 0;
  const sla = {} as Record<SlaPriority, Record<Metric, ReturnType<typeof emptyCell>>>;
  for (const p of PRIORITIES) {
    sla[p] = {} as Record<Metric, ReturnType<typeof emptyCell>>;
    for (const k of METRIC_KEYS) sla[p][k] = emptyCell();
  }
  const overall = {} as Record<Metric, ReturnType<typeof emptyCell>>;
  for (const k of METRIC_KEYS) overall[k] = emptyCell();
  const A = {
    from: o.from,
    to: o.to,
    total: cases.length,
    evaluable: 0,
    byPrio,
    bucket: dict(),
    category: dict(),
    disp: dict(),
    closeR: dict(),
    auto: 0,
    tp: 0,
    open: 0,
    uncategorized: 0,
    simulation: 0,
    tier12: 0,
    tier3: 0,
    heat: Object.create(null) as Record<string, number[]>,
    dispByTitle: Object.create(null) as Record<string, Counts>,
  };
  const daily = new Map<string, Counts>();
  const hourBuckets = o.to - o.from <= 2 * DAY;
  const worstAll: Record<Metric, { caseId: string; title: string; el: number }[]> = { TTA: [], TTI: [], TTC: [], TTR: [] };
  for (const c of cases) {
    const pr = c.priority;
    if (pr) A.byPrio[pr]++;
    if (pr && pr !== "Informational") A.evaluable++;
    bump(A.bucket, c.bucket);
    bump(A.category, c.category);
    if (c.category === "Uncategorized") A.uncategorized++;
    if (c.subcategory === "Simulation") A.simulation++;
    if (/automated closure/i.test(c.rootCause)) A.auto++;
    const d = c.disposition || "Unknown";
    bump(A.disp, d);
    if (/^true positive$/i.test(d)) A.tp++;
    if (c.isOpen) A.open++;
    bump(A.closeR, closeReasonBucket(c));
    if (/tier\s*-?[12]\b/i.test(c.assignee)) A.tier12++;
    else if (/tier\s*-?3\b/i.test(c.assignee)) A.tier3++;
    const t = c.ts.createdAt;
    if (t != null && !Number.isNaN(t)) {
      const key = hourBuckets ? String(zoned(t, o.settings.periodTz).h).padStart(2, "0") + ":00" : ymdOf(t, o.settings.periodTz);
      if (!daily.has(key)) daily.set(key, dict());
      bump(daily.get(key)!, d);
      const hk = c.title || "(no title)";
      const hr = zoned(t, o.settings.displayTz).h;
      (A.heat[hk] ??= new Array(24).fill(0))[hr]++;
      bump((A.dispByTitle[hk] ??= dict()), d);
    }
    if (!pr || pr === "Informational") continue;
    for (const k of METRIC_KEYS) {
      const r = c.ev[k],
        cell = sla[pr][k],
        ov = overall[k];
      const f = r.s === "MET" ? "met" : r.s === "NOT_MET" ? "notMet" : r.s === "PENDING" ? "pending" : r.s === "NA" ? "na" : "err";
      cell[f]++;
      ov[f]++;
      if ((r.s === "MET" || r.s === "NOT_MET") && r.el != null && !r.imputed) {
        cell.vals.push(r.el);
        ov.vals.push(r.el);
      }
      if (r.imputed) {
        cell.zero++;
        ov.zero++;
      }
      if (r.s === "NOT_MET" && r.el != null) {
        cell.worst.push({ caseId: c.caseId, title: c.title, el: r.el });
        worstAll[k].push({ caseId: c.caseId, title: c.title, el: r.el });
      }
    }
  }
  // Empty buckets read as zero, never as gaps.
  if (hourBuckets) {
    for (let h = 0; h < 24; h++) {
      const k = String(h).padStart(2, "0") + ":00";
      if (!daily.has(k)) daily.set(k, dict());
    }
  } else {
    for (let t = o.from; t < o.to; t += DAY / 2) {
      const k = ymdOf(t, o.settings.periodTz);
      if (!daily.has(k) && t < o.to) daily.set(k, dict());
    }
  }
  const fin = (cell: ReturnType<typeof emptyCell>, tgt: number | null): SlaCell => {
    const den = cell.met + cell.notMet;
    const s = cell.vals.slice().sort((a, b) => a - b);
    const pct = den ? round2((cell.met / den) * 100) : null;
    const status = pct === null || tgt == null ? "none" : pct >= tgt ? "ok" : "bad";
    const { vals: _v, ...rest } = cell;
    void _v;
    return {
      ...rest,
      n: den,
      pct,
      target: tgt,
      status,
      variance: pct !== null && tgt != null ? round2(pct - tgt) : null,
      mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null,
      median: quantile(s, 0.5),
      p95: quantile(s, 0.95),
      worst: cell.worst.sort((a, b) => b.el - a.el).slice(0, 5),
    };
  };
  const slaOut = {} as Record<SlaPriority, Record<Metric, SlaCell>>;
  for (const p of PRIORITIES) {
    slaOut[p] = {} as Record<Metric, SlaCell>;
    for (const k of METRIC_KEYS) slaOut[p][k] = fin(sla[p][k], o.targets ? o.targets[p][k] : null);
  }
  const overallOut = {} as Record<Metric, SlaCell>;
  for (const k of METRIC_KEYS) {
    overall[k].worst = worstAll[k];
    overallOut[k] = fin(overall[k], null);
  }
  return {
    ...A,
    sla: slaOut,
    overall: overallOut,
    daily: [...daily.entries()].filter(([k]) => hourBuckets || k.length === 10).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  };
}
