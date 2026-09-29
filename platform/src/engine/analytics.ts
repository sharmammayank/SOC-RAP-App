/* Heatmaps (spec §6.1), period comparison and generated observations (spec §6.2). Pure functions over aggregated cases. */
import type { AggCase, Aggregate } from "./aggregate";
import { dict } from "./aggregate";
import type { Metric, SlaPriority } from "./types";
import { ALL_PRIORITIES, METRIC_KEYS, PRIORITIES } from "./types";
import { ymdOf, zoned } from "./tz";
import { mondayOf } from "./periods";

export type Granularity = "hour" | "day" | "week" | "month";
export type HeatKind = "volumeByHour" | "detectionByHour" | "categoryByTime" | "breachDensity" | "categoryByPriority" | "dispositionByDetection";

export const HEAT_KINDS: { k: HeatKind; label: string; hint: string }[] = [
  { k: "volumeByHour", label: "Alert volume by hour", hint: "Weekday (or date) × hour of day" },
  { k: "detectionByHour", label: "Detections by hour", hint: "Top detections × hour of day" },
  { k: "categoryByTime", label: "Category over time", hint: "Category × date, week or month" },
  { k: "breachDensity", label: "SLA breach density", hint: "Priority × time, NOT MET count or breach %" },
  { k: "categoryByPriority", label: "Category by priority", hint: "Category × priority" },
  { k: "dispositionByDetection", label: "Disposition by detection", hint: "Top detections × disposition" },
];

export interface HeatOptions {
  kind: HeatKind;
  granularity: Granularity;
  displayTz: string;
  periodTz: string;
  topN: number;
  /** For breach density: which metric, and count vs percentage. */
  metric?: Metric | "ANY";
  breachMode?: "count" | "pct";
  /** Volume by hour: rows by weekday or by date. */
  rowsBy?: "weekday" | "date";
}
export interface HeatGrid {
  rows: string[];
  cols: string[];
  /** cells[r][c] */
  cells: number[][];
  /** Denominators for percentage cells (breach %), same shape. */
  denom?: number[][];
  rowTotals: number[];
  colTotals: number[];
  total: number;
  max: number;
  valueKind: "count" | "pct";
  rowKey: (c: AggCase) => string | null;
  colKey: (c: AggCase) => string | string[] | null;
}

const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));

export function timeKey(ms: number, g: Granularity, o: { displayTz: string; periodTz: string }): string {
  if (g === "hour") return String(zoned(ms, o.displayTz).h).padStart(2, "0");
  const d = ymdOf(ms, o.periodTz);
  if (g === "day") return d;
  if (g === "week") return mondayOf(d);
  return d.slice(0, 7);
}

function breached(c: AggCase, m: Metric | "ANY"): { breach: boolean; evaluable: boolean } {
  const ks = m === "ANY" ? METRIC_KEYS : [m];
  let ev = false,
    br = false;
  for (const k of ks) {
    const s = c.ev[k]?.s;
    if (s === "MET" || s === "NOT_MET") ev = true;
    if (s === "NOT_MET") br = true;
  }
  return { breach: br, evaluable: ev };
}

function topKeys(cases: AggCase[], f: (c: AggCase) => string, n: number): string[] {
  const cnt = dict();
  for (const c of cases) {
    const k = f(c);
    cnt[k] = (cnt[k] || 0) + 1;
  }
  return Object.entries(cnt)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map((x) => x[0]);
}

/** Every heatmap re-renders from already-calculated cases; no recalculation (spec AT-09). Empty cells are true zeros. */
export function heatmap(cases: AggCase[], o: HeatOptions, window: { from: number; to: number }): HeatGrid {
  const inWin = cases.filter((c) => c.ts.createdAt != null && c.ts.createdAt >= window.from && c.ts.createdAt < window.to);
  const tk = (c: AggCase) => timeKey(c.ts.createdAt!, o.granularity, o);
  let rows: string[] = [],
    cols: string[] = [];
  let rowKey: HeatGrid["rowKey"],
    colKey: HeatGrid["colKey"];
  let pct = false;
  // Time columns span the whole window so quiet periods show as zero.
  const timeCols = () => {
    if (o.granularity === "hour") return HOURS;
    const s = new Set<string>();
    for (let t = window.from; t < window.to; t += 3 * 3600000) s.add(timeKey(t, o.granularity, o));
    for (const c of inWin) s.add(tk(c));
    return [...s].sort();
  };
  switch (o.kind) {
    case "volumeByHour": {
      const byDate = o.rowsBy === "date";
      rows = byDate ? [...new Set(inWin.map((c) => ymdOf(c.ts.createdAt!, o.displayTz)))].sort() : WD;
      if (byDate) {
        const s = new Set(rows);
        for (let t = window.from; t < window.to; t += 3 * 3600000) s.add(ymdOf(t, o.displayTz));
        rows = [...s].sort();
      }
      cols = HOURS;
      rowKey = (c) => (byDate ? ymdOf(c.ts.createdAt!, o.displayTz) : WD[zoned(c.ts.createdAt!, o.displayTz).wd]);
      colKey = (c) => String(zoned(c.ts.createdAt!, o.displayTz).h).padStart(2, "0");
      break;
    }
    case "detectionByHour":
      rows = topKeys(inWin, (c) => c.title || "(no title)", o.topN);
      cols = HOURS;
      rowKey = (c) => c.title || "(no title)";
      colKey = (c) => String(zoned(c.ts.createdAt!, o.displayTz).h).padStart(2, "0");
      break;
    case "categoryByTime":
      rows = topKeys(inWin, (c) => c.category, o.topN);
      cols = timeCols();
      rowKey = (c) => c.category;
      colKey = tk;
      break;
    case "breachDensity":
      rows = [...PRIORITIES];
      cols = timeCols();
      pct = o.breachMode === "pct";
      rowKey = (c) => (c.priority && c.priority !== "Informational" ? c.priority : null);
      colKey = tk;
      break;
    case "categoryByPriority":
      rows = topKeys(inWin, (c) => c.category, o.topN);
      cols = [...ALL_PRIORITIES];
      rowKey = (c) => c.category;
      colKey = (c) => c.priority;
      break;
    case "dispositionByDetection":
      rows = topKeys(inWin, (c) => c.title || "(no title)", o.topN);
      cols = topKeys(inWin, (c) => c.disposition || "Unknown", 8);
      rowKey = (c) => c.title || "(no title)";
      colKey = (c) => c.disposition || "Unknown";
      break;
  }
  const ri = new Map(rows.map((r, i) => [r, i])),
    ci = new Map(cols.map((c, i) => [c, i]));
  const cells = rows.map(() => new Array(cols.length).fill(0));
  const denom = rows.map(() => new Array(cols.length).fill(0));
  for (const c of inWin) {
    const r = rowKey(c);
    if (r == null || !ri.has(r)) continue;
    const ck = colKey(c);
    const cks = Array.isArray(ck) ? ck : ck == null ? [] : [ck];
    for (const k of cks) {
      const j = ci.get(k);
      if (j === undefined) continue;
      if (o.kind === "breachDensity") {
        const b = breached(c, o.metric ?? "ANY");
        if (b.evaluable) denom[ri.get(r)!][j]++;
        if (b.breach) cells[ri.get(r)!][j]++;
      } else cells[ri.get(r)!][j]++;
    }
  }
  const counts = cells;
  const values = pct ? cells.map((row, i) => row.map((v, j) => (denom[i][j] ? Math.round((v / denom[i][j]) * 10000) / 100 : 0))) : counts;
  const rowTotals = counts.map((r) => r.reduce((a, b) => a + b, 0));
  const colTotals = cols.map((_, j) => counts.reduce((a, r) => a + r[j], 0));
  return {
    rows,
    cols,
    cells: values,
    denom: o.kind === "breachDensity" ? denom : undefined,
    rowTotals,
    colTotals,
    total: rowTotals.reduce((a, b) => a + b, 0),
    max: Math.max(0, ...values.flat()),
    valueKind: pct ? "pct" : "count",
    rowKey,
    colKey,
  };
}

/** Cases behind one heatmap cell (drill-through). */
export function cellCases(cases: AggCase[], g: HeatGrid, r: number, c: number, window: { from: number; to: number }): AggCase[] {
  const rk = g.rows[r],
    ck = g.cols[c];
  return cases.filter((x) => {
    if (x.ts.createdAt == null || x.ts.createdAt < window.from || x.ts.createdAt >= window.to) return false;
    if (g.rowKey(x) !== rk) return false;
    const k = g.colKey(x);
    return Array.isArray(k) ? k.includes(ck) : k === ck;
  });
}

/* ------------------------------ Comparison ------------------------------ */

export interface Materiality {
  /** Minimum absolute change in case count for a volume observation. */
  minAbs: number;
  /** Minimum percentage change for a volume observation. */
  minPct: number;
  /** Minimum share of volume (%) for a concentration observation. */
  concentrationPct: number;
}
export const DEFAULT_MATERIALITY: Materiality = { minAbs: 10, minPct: 5, concentrationPct: 25 };

export interface Observation {
  kind: "volume" | "priority" | "driver" | "emerging" | "compliance" | "concentration" | "breach" | "quality" | "automation" | "tp" | "open";
  text: string;
  /** Rank: larger = more material. */
  weight: number;
  /** Values the sentence is built from, so every statement is traceable (spec §6.2). */
  basis: Record<string, number | string | null>;
}

const fi = (n: number) => Number(n).toLocaleString("en-US");
const fp = (x: number | null, dp = 2) => (x == null ? "—" : x.toFixed(dp).replace(/\.00$/, "") + "%");

export interface CompareRow {
  key: string;
  cur: number;
  prev: number | null;
  delta: number | null;
  pct: number | null;
  status?: "new" | "gone";
}
export function compareCounts(cur: Record<string, number>, prev: Record<string, number> | null): CompareRow[] {
  const keys = new Set([...Object.keys(cur), ...Object.keys(prev ?? {})]);
  return [...keys]
    .map((k) => {
      const a = cur[k] || 0,
        b = prev ? prev[k] || 0 : null;
      return {
        key: k,
        cur: a,
        prev: b,
        delta: b == null ? null : a - b,
        pct: b ? ((a - b) / b) * 100 : null,
        status: prev && b === 0 && a > 0 ? ("new" as const) : prev && a === 0 && (b ?? 0) > 0 ? ("gone" as const) : undefined,
      };
    })
    .sort((x, y) => y.cur - x.cur || (y.prev ?? 0) - (x.prev ?? 0));
}

export interface SlaCompareRow {
  priority: SlaPriority;
  metric: Metric;
  cur: number | null;
  prev: number | null;
  delta: number | null;
  target: number | null;
  status: "ok" | "bad" | "none";
  crossed: "recovered" | "newly_below" | null;
  meanCur: number | null;
  meanPrev: number | null;
  p95Cur: number | null;
  p95Prev: number | null;
}
export function compareSla(A: Aggregate, P: Aggregate | null): SlaCompareRow[] {
  const out: SlaCompareRow[] = [];
  for (const p of PRIORITIES)
    for (const m of METRIC_KEYS) {
      const a = A.sla[p][m],
        b = P && P.total ? P.sla[p][m] : null;
      const crossed = a.pct != null && b?.pct != null && a.target != null && a.status !== b.status && b.status !== "none" ? (a.status === "ok" ? "recovered" : "newly_below") : null;
      out.push({
        priority: p,
        metric: m,
        cur: a.pct,
        prev: b?.pct ?? null,
        delta: a.pct != null && b?.pct != null ? Math.round((a.pct - b.pct) * 100) / 100 : null,
        target: a.target,
        status: a.status,
        crossed,
        meanCur: a.mean,
        meanPrev: b?.mean ?? null,
        p95Cur: a.p95,
        p95Prev: b?.p95 ?? null,
      });
    }
  return out;
}

/** Share-of-total shift in points per priority. */
export function priorityShift(A: Aggregate, P: Aggregate | null) {
  return ALL_PRIORITIES.map((p) => {
    const sa = A.total ? (A.byPrio[p] / A.total) * 100 : 0,
      sb = P && P.total ? (P.byPrio[p] / P.total) * 100 : null;
    return { priority: p, cur: A.byPrio[p], prev: P ? P.byPrio[p] : null, share: sa, prevShare: sb, shiftPts: sb == null ? null : sa - sb };
  });
}

/** Hour and weekday concentration: the busiest 4-hour band and weekday, and their shares. */
export function concentration(cases: AggCase[], displayTz: string) {
  const hours = new Array(24).fill(0),
    wds = new Array(7).fill(0);
  for (const c of cases) {
    if (c.ts.createdAt == null) continue;
    const z = zoned(c.ts.createdAt, displayTz);
    hours[z.h]++;
    wds[z.wd]++;
  }
  let best = 0,
    bi = 0;
  for (let i = 0; i < 24; i++) {
    const w = hours[i] + hours[(i + 1) % 24] + hours[(i + 2) % 24] + hours[(i + 3) % 24];
    if (w > best) {
      best = w;
      bi = i;
    }
  }
  const total = hours.reduce((a, b) => a + b, 0);
  const wi = wds.indexOf(Math.max(...wds));
  return { hours, weekdays: wds, bandStart: bi, bandCount: best, bandShare: total ? (best / total) * 100 : 0, topWeekday: WD[wi], weekdayShare: total ? (wds[wi] / total) * 100 : 0, total };
}

/** Priority × category pairing with the highest NOT MET density. */
export function breachHotspot(cases: AggCase[]) {
  const m = new Map<string, { n: number; b: number; p: string; cat: string }>();
  for (const c of cases) {
    if (!c.priority || c.priority === "Informational") continue;
    const k = c.priority + "\u0000" + c.category;
    const x = m.get(k) ?? { n: 0, b: 0, p: c.priority, cat: c.category };
    let ev = false,
      br = false;
    for (const mk of METRIC_KEYS) {
      const s = c.ev[mk].s;
      if (s === "MET" || s === "NOT_MET") ev = true;
      if (s === "NOT_MET") br = true;
    }
    if (ev) x.n++;
    if (br) x.b++;
    m.set(k, x);
  }
  return [...m.values()].filter((x) => x.n >= 5 && x.b > 0).sort((a, b) => b.b / b.n - a.b / a.n || b.b - a.b)[0] ?? null;
}

export interface ObservationInput {
  A: Aggregate;
  P: Aggregate | null;
  cur: AggCase[];
  curLabel: string;
  prevLabel: string;
  source: string;
  displayTz: string;
  tzLabel: string;
  materiality: Materiality;
  /** Data quality: current and prior blocking exception counts, if known. */
  blocking?: { cur: number; prev: number | null };
}

/** Templated, traceable observations ranked by materiality (spec §6.2). */
export function observations(i: ObservationInput): Observation[] {
  const { A, P, materiality: mt } = i;
  const o: Observation[] = [];
  const hasP = !!(P && P.total);
  const d = hasP ? A.total - P!.total : 0,
    pc = hasP ? (d / P!.total) * 100 : null;
  if (hasP)
    o.push({
      kind: "volume",
      weight: 100,
      text: `${i.curLabel} case volume totaled ${fi(A.total)} ${i.source} cases, ${d === 0 ? "unchanged" : d > 0 ? "an increase of " + fi(d) : "a decrease of " + fi(-d)}${d ? ` (${pc! >= 0 ? "+" : ""}${pc!.toFixed(1)}%)` : ""} from ${i.prevLabel}.`,
      basis: { current: A.total, previous: P!.total, delta: d, pct: pc },
    });
  else o.push({ kind: "volume", weight: 100, text: `${i.curLabel} case volume totaled ${fi(A.total)} ${i.source} cases. No data is available for ${i.prevLabel}, so there is no comparison.`, basis: { current: A.total } });
  o.push({
    kind: "priority",
    weight: 95,
    text: `${fi(A.byPrio.Critical)} Critical, ${fi(A.byPrio.High)} High, ${fi(A.byPrio.Medium)} Medium, ${fi(A.byPrio.Low)} Low and ${fi(A.byPrio.Informational)} Informational cases were triggered.`,
    basis: { ...A.byPrio },
  });
  if (hasP) {
    const rows = compareCounts(A.bucket, P!.bucket);
    // Uncategorized volume is reported under data quality, not as a new source.
    const emerging = rows.filter((r) => r.status === "new" && r.key !== "Uncategorized");
    if (emerging.length)
      o.push({
        kind: "emerging",
        weight: 90,
        text: `New this period: ${emerging.map((x) => `${x.key} (${fi(x.cur)})`).join(", ")}, absent in ${i.prevLabel}.`,
        basis: Object.fromEntries(emerging.map((x) => [x.key, x.cur])),
      });
    const drivers = rows.filter((r) => r.delta != null && r.prev! > 0 && Math.abs(r.delta) >= mt.minAbs && Math.abs(r.pct ?? 0) >= mt.minPct).sort((a, b) => Math.abs(b.delta!) - Math.abs(a.delta!));
    const up = drivers.filter((r) => (r.delta ?? 0) > 0)[0];
    if (up && d !== 0)
      o.push({
        kind: "driver",
        weight: 85,
        text: `${up.key} had the largest increase: +${fi(up.delta!)} (${fi(up.prev!)} → ${fi(up.cur)})${d > 0 ? `, ${Math.round((up.delta! / d) * 100)}% of the total change` : ""}.`,
        basis: { bucket: up.key, prev: up.prev, cur: up.cur, delta: up.delta, totalDelta: d },
      });
    // A bucket that dropped to zero is reported once, as "no cases this period".
    const down = drivers.filter((r) => (r.delta ?? 0) < 0 && r.cur > 0)[0];
    if (down) o.push({ kind: "driver", weight: 70, text: `${down.key} had the largest decrease: −${fi(-down.delta!)} (${fi(down.prev!)} → ${fi(down.cur)}).`, basis: { bucket: down.key, prev: down.prev, cur: down.cur, delta: down.delta } });
    const gone = rows.filter((r) => r.status === "gone");
    if (gone.length) o.push({ kind: "emerging", weight: 50, text: `No cases this period from ${gone.map((g) => g.key).join(", ")}, which appeared in ${i.prevLabel}.`, basis: Object.fromEntries(gone.map((x) => [x.key, x.prev])) });
  }
  const sla = compareSla(A, P);
  const crossed = sla.filter((r) => r.crossed);
  for (const r of crossed)
    o.push({
      kind: "compliance",
      weight: r.crossed === "newly_below" ? 92 : 75,
      text: `${r.priority} ${r.metric} ${r.crossed === "newly_below" ? "fell below" : "recovered above"} its ${r.target}% target: ${fp(r.prev)} → ${fp(r.cur)}.`,
      basis: { priority: r.priority, metric: r.metric, prev: r.prev, cur: r.cur, target: r.target },
    });
  const miss = sla.filter((r) => r.status === "bad" && !r.crossed);
  if (miss.length) o.push({ kind: "compliance", weight: 88, text: `SLA targets missed: ${miss.map((r) => `${r.priority} ${r.metric} ${fp(r.cur)} vs ${r.target}%`).join("; ")}.`, basis: Object.fromEntries(miss.map((r) => [`${r.priority} ${r.metric}`, r.cur])) });
  else if (!crossed.some((r) => r.crossed === "newly_below")) o.push({ kind: "compliance", weight: 60, text: "All SLA compliance targets were met for evaluable cases.", basis: {} });
  const conc = concentration(i.cur, i.displayTz);
  if (conc.total && conc.bandShare >= mt.concentrationPct)
    o.push({
      kind: "concentration",
      weight: 55,
      text: `The busiest 4-hour window was ${String(conc.bandStart).padStart(2, "0")}:00–${String((conc.bandStart + 4) % 24).padStart(2, "0")}:00 ${i.tzLabel}, with ${fi(conc.bandCount)} cases (${conc.bandShare.toFixed(0)}% of volume).`,
      basis: { start: conc.bandStart, count: conc.bandCount, share: conc.bandShare },
    });
  const hot = breachHotspot(i.cur);
  if (hot) o.push({ kind: "breach", weight: 65, text: `Breaches were most concentrated in ${hot.p} ${hot.cat} cases: ${fi(hot.b)} of ${fi(hot.n)} evaluable (${((hot.b / hot.n) * 100).toFixed(1)}%) missed at least one SLA.`, basis: { priority: hot.p, category: hot.cat, breached: hot.b, evaluable: hot.n } });
  if (A.auto) o.push({ kind: "automation", weight: 45, text: `Automation closed ${fi(A.auto)} cases (${((A.auto / A.total) * 100).toFixed(1)}% of volume).`, basis: { auto: A.auto, total: A.total } });
  if (A.tp) {
    const tpB = dict();
    for (const c of i.cur) if (/^true positive$/i.test(c.disposition)) tpB[c.bucket] = (tpB[c.bucket] || 0) + 1;
    const top = Object.entries(tpB).sort((a, b) => b[1] - a[1]).slice(0, 3);
    o.push({ kind: "tp", weight: 58, text: `${fi(A.tp)} true positive cases, led by ${top.map(([k, v]) => `${k} (${fi(v)})`).join(", ")}.`, basis: { tp: A.tp, ...Object.fromEntries(top) } });
  }
  if (A.open) o.push({ kind: "open", weight: 40, text: `${fi(A.open)} cases remain open (waiting on the client or under active coordination).`, basis: { open: A.open } });
  const ur = A.total ? (A.uncategorized / A.total) * 100 : 0,
    urp = hasP ? (P!.uncategorized / P!.total) * 100 : null;
  if (A.uncategorized || (urp ?? 0) > 0)
    o.push({
      kind: "quality",
      weight: 35,
      text: `Uncategorized rate ${ur.toFixed(1)}%${urp != null ? ` (${urp.toFixed(1)}% in ${i.prevLabel})` : ""}${i.blocking ? `; ${fi(i.blocking.cur)} blocking exception${i.blocking.cur === 1 ? "" : "s"} resolved before publishing` : ""}.`,
      basis: { current: ur, previous: urp },
    });
  return o.sort((a, b) => b.weight - a.weight);
}

/** Per-detection disposition profile and next actions (the deck's MDR analysis slide). */
export function detectionInsights(A: Aggregate, tzLabel: string, displayTz: string, cases: AggCase[]) {
  const rows = Object.entries(A.dispByTitle)
    .map(([t, d]) => {
      const n = Object.values(d).reduce((a, b) => a + b, 0);
      return { t, n, tp: ((d["True Positive"] || 0) / n) * 100, bp: ((d["Benign Positive"] || 0) / n) * 100, fp: ((d["False Positive"] || 0) / n) * 100 };
    })
    .sort((a, b) => b.n - a.n);
  const share = (r: { n: number }) => (A.total ? (r.n / A.total) * 100 : 0);
  const acts: [string, string][] = [];
  const pri = rows.filter((r) => r.tp >= 80 && r.n >= 10).slice(0, 2);
  const tune = rows.filter((r) => r.bp >= 90 && r.n >= 20).slice(0, 2);
  const val = rows.filter((r) => r.bp >= 99.5 && r.n >= 10 && !tune.includes(r)).slice(0, 1);
  const mon = rows.filter((r) => share(r) >= 15 && r.tp >= 50).slice(0, 1);
  if (pri.length) acts.push(["Prioritize", `Keep focus on ${pri.map((r) => `${r.t} (~${Math.round(r.tp)}% TP)`).join(" and ")} as high-confidence detections.`]);
  if (tune.length) acts.push(["Tune", `Review ${tune.map((r) => `${r.t} (~${Math.round(r.bp)}% BP)`).join(" and ")} for tuning opportunities.`]);
  if (val.length) acts.push(["Validate", `Review ${val[0].t} (100% BP) to see whether detection logic or enrichment can be improved.`]);
  if (mon.length) acts.push(["Monitor", `Keep watching ${mon[0].t}, which combines high volume (~${Math.round(share(mon[0]))}% of alerts) with a ~${Math.round(mon[0].tp)}% true positive rate.`]);
  acts.push(["Measure", "Track alert volume and disposition period over period to confirm tuning improves quality without losing detection coverage."]);
  acts.push(["Align", "Keep comparing hourly alert volume with analyst availability and adjust coverage if the pattern shifts."]);
  const conc = concentration(cases, displayTz);
  const f: string[] = [];
  if (rows[0]) f.push(`${rows[0].t} generated ${fi(rows[0].n)} alerts (~${Math.round(share(rows[0]))}% of volume), the largest single volume driver.`);
  if (rows[1]) f.push(`${rows[1].t} generated ${fi(rows[1].n)} alerts, the second-largest driver.`);
  if (rows[0]) f.push(`${rows[0].t} had a ~${Math.round(rows[0].tp)}% true positive rate.`);
  if (conc.total) f.push(`The busiest 4-hour window was ${String(conc.bandStart).padStart(2, "0")}:00–${String((conc.bandStart + 4) % 24).padStart(2, "0")}:00 ${tzLabel}, with ${fi(conc.bandCount)} alerts (${conc.bandShare.toFixed(0)}%).`);
  return { rows, acts, findings: f };
}
