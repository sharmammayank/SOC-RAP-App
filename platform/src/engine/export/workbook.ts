/* Processed workbook, exception report and slide-ready tables (spec §3.2 step 9, M9). */
import type { Aggregate } from "../aggregate";
import { dict } from "../aggregate";
import type { Issue, Limits, Targets } from "../types";
import { ALL_PRIORITIES, METRICS, PRIORITIES } from "../types";
import { fmtLimit } from "../defaults";
import { fmtInTz, ymdOf, tzAbbrev } from "../tz";
import { writeXlsx, ST, HEAT_LEVELS, type OutCell, type OutSheet } from "../xlsx/writer";
import { ISSUE_LABEL } from "../run";
import type { AggCase } from "../aggregate";

export interface ReportCase extends AggCase {
  rowNo: number;
  subcategory: string;
  ruleId?: string;
  match?: string;
  excluded?: boolean;
  excludedReason?: string;
  stage?: string;
  ts: { createdAt: number | null; assignedAt?: number | null; investigatedTill?: number | null; containmentAt?: number | null; closedAt?: number | null };
}
export interface ReportEdit {
  at: string;
  actor: string;
  kind: string;
  caseId: string | null;
  rowNo: number | null;
  field: string | null;
  oldValue: unknown;
  newValue: unknown;
  reason: string;
}
export interface ReportInput {
  client: string;
  source: string;
  label: string;
  short: string;
  period: { start: string; end: string; cadence: string };
  periodTz: string;
  displayTz: string;
  A: Aggregate;
  P: Aggregate | null;
  P2: Aggregate | null;
  prevLabel: string;
  prevShort: string;
  p2Short: string;
  cases: ReportCase[];
  limits: Limits;
  targets: Targets;
  thresholdLabel: string;
  rulesetLabel: string;
  file: { name: string; sha256: string; sheet: string; rows: number };
  runStatus: string;
  publishedAt: string | null;
  issues: (Issue & { status: string })[];
  edits: ReportEdit[];
  observations: string[];
  counts: { rows: number; included: number; outOfPeriod: number; dropped: number; evaluable: number; informational: number };
}

const fmtDurSec = (s: number | null) => (s == null ? null : Math.round(s));
const b = (v: OutCell) => ({ v: v as string | number | null, s: ST.bold });

export async function buildWorkbook(r: ReportInput): Promise<Blob> {
  const A = r.A,
    P = r.P,
    P2 = r.P2;
  const sheets: OutSheet[] = [];
  sheets.push({
    name: "README",
    header: false,
    widths: [30, 110],
    rows: [
      [b("Report"), "SOC SLA and service review — processed workbook"],
      [b("Client"), r.client],
      [b("Period"), `${r.label} (${r.period.start} to ${r.period.end}, ${r.period.cadence})`],
      [b("Compared with"), P && P.total ? r.prevLabel : `${r.prevLabel} (no data)`],
      [b("Periods counted in"), `${r.periodTz} (${tzAbbrev(r.periodTz)})`],
      [b("Times shown in"), `${r.displayTz} (${tzAbbrev(r.displayTz)})`],
      [b("Source file"), `${r.file.name} [${r.file.sheet}] ${r.file.rows} rows, SHA-256 ${r.file.sha256}`],
      [b("SLA threshold version"), r.thresholdLabel],
      [b("Rule-set version"), r.rulesetLabel],
      [b("Run status"), r.runStatus + (r.publishedAt ? ` (${r.publishedAt})` : "")],
      [b("Generated"), new Date().toISOString()],
      [b("Imported rows"), r.counts.rows],
      [b("Cases in period"), A.total],
      [b("Out of period (excluded)"), r.counts.outOfPeriod],
      [b("Dropped in review"), r.counts.dropped],
      [b("SLA-evaluable"), A.evaluable],
      [b("Informational (excluded from SLA)"), A.byPrio.Informational],
      [b("Review edits"), r.edits.length],
      [b("SLA rule"), "Compliance % = MET / (MET + NOT MET) × 100. PENDING, NOT APPLICABLE and DATA ERROR are excluded from both numerator and denominator."],
      [b("Formula safety"), "Text starting with = + - @ is prefixed with an apostrophe so it can't run as a formula."],
    ],
  });
  const sla: OutCell[][] = [["Priority", "Metric", "Limit", "Limit (seconds)", "Target %", "Met", "Not met", "Pending", "N/A", "Data error", "Counted as 0 s", "Compliance %", "Variance (pts)", "Status", "Mean (s)", "Median (s)", "P95 (s)", `Previous % (${r.prevShort})`]];
  for (const p of PRIORITIES)
    for (const m of METRICS) {
      const c = A.sla[p][m.k],
        pc = P?.sla[p][m.k];
      sla.push([
        p,
        m.k,
        fmtLimit(r.limits[p][m.k]),
        r.limits[p][m.k].seconds,
        c.target,
        c.met,
        c.notMet,
        c.pending,
        c.na,
        c.err,
        c.zero,
        c.pct,
        c.variance,
        { v: c.pct == null ? "No evaluable cases" : c.status === "ok" ? "Attained" : "Breached", s: c.pct == null ? 0 : c.status === "ok" ? ST.good : ST.bad },
        fmtDurSec(c.mean),
        fmtDurSec(c.median),
        fmtDurSec(c.p95),
        P && P.total ? pc?.pct ?? null : null,
      ]);
    }
  for (const m of METRICS) {
    const c = A.overall[m.k];
    sla.push([b("All priorities"), b(m.k), "", "", "", c.met, c.notMet, c.pending, c.na, c.err, c.zero, c.pct, "", "", fmtDurSec(c.mean), fmtDurSec(c.median), fmtDurSec(c.p95), P && P.total ? P.overall[m.k].pct : null]);
  }
  sheets.push({ name: "SLA Compliance", widths: [14, 8, 14, 14, 9, 8, 9, 9, 8, 10, 13, 13, 13, 18, 12, 12, 12, 16], rows: sla });
  const wr: OutCell[][] = [["Metric", "Rank", "Case ID", "Title", "Elapsed (s)"]];
  for (const m of METRICS) A.overall[m.k].worst.forEach((w, i) => wr.push([m.k, i + 1, w.caseId, w.title, Math.round(w.el)]));
  sheets.push({ name: "Worst Breaches", widths: [8, 6, 16, 70, 12], rows: wr });
  const tz = r.displayTz;
  const hdr = ["Row", "Case ID", "Title", "Priority", "Category", "Sub-category", "Report bucket", "Rule", "Matched text", `Created (${tzAbbrev(tz)})`, `Acknowledged (${tzAbbrev(tz)})`, `Closed (${tzAbbrev(tz)})`, "Created UTC", "Disposition", "Close reason", "Root cause", "Assignee", "Open", "Excluded", ...METRICS.flatMap((m) => [`${m.k} seconds`, `${m.k} status`, `${m.k} note`])];
  const cr: OutCell[][] = [hdr];
  for (const c of r.cases) {
    cr.push([
      c.rowNo,
      c.caseId,
      c.title,
      c.priority ?? "Invalid",
      c.category,
      c.subcategory,
      c.bucket,
      c.ruleId ?? "",
      c.match ?? "",
      fmtInTz(c.ts.createdAt, tz, true),
      fmtInTz(c.ts.assignedAt ?? null, tz, true),
      fmtInTz(c.ts.closedAt ?? null, tz, true),
      c.ts.createdAt != null && !Number.isNaN(c.ts.createdAt) ? new Date(c.ts.createdAt).toISOString() : "",
      c.disposition,
      c.closeReason,
      c.rootCause,
      c.assignee,
      c.isOpen,
      c.excluded ? c.excludedReason ?? "yes" : "",
      ...METRICS.flatMap((m) => {
        const x = c.ev[m.k];
        return [x.el != null ? Math.round(x.el) : null, { v: x.s.replace("_", " "), s: x.s === "MET" ? ST.good : x.s === "NOT_MET" || x.s === "ERROR" ? ST.bad : x.s === "PENDING" ? ST.warn : 0 }, x.why ?? ""] as OutCell[];
      }),
    ]);
  }
  sheets.push({ name: "Cases", filter: true, widths: hdr.map((x) => (x === "Title" ? 60 : x.includes("note") ? 28 : 15)), rows: cr });
  const bks = Object.keys(A.bucket).sort((x, y) => A.bucket[y] - A.bucket[x]);
  const byDay = new Map<string, Record<string, number>>();
  for (const c of r.cases) {
    if (c.excluded || c.ts.createdAt == null) continue;
    const d = ymdOf(c.ts.createdAt, r.periodTz);
    if (!byDay.has(d)) byDay.set(d, dict());
    const o = byDay.get(d)!;
    o[c.bucket] = (o[c.bucket] || 0) + 1;
  }
  const ct: OutCell[][] = [["Day", ...bks, "Total"]];
  for (const [d] of A.daily) {
    const o = byDay.get(d) ?? {};
    ct.push([d, ...bks.map((k) => o[k] || 0), bks.reduce((a, k) => a + (o[k] || 0), 0)]);
  }
  ct.push([b("Total"), ...bks.map((k) => b(A.bucket[k])), b(A.total)]);
  sheets.push({ name: "Category Trend", widths: [14, ...bks.map(() => 15), 10], rows: ct });
  const dks = Object.keys(A.disp).sort();
  sheets.push({ name: "Disposition Trend", widths: [14, ...dks.map(() => 16), 10], rows: [["Day", ...dks, "Total"], ...A.daily.map(([d, o]) => [d, ...dks.map((k) => o[k] || 0), dks.reduce((a, k) => a + (o[k] || 0), 0)])] });
  const hrows = Object.entries(A.heat)
    .map(([t, a]) => ({ t, a, n: a.reduce((x, y) => x + y, 0) }))
    .sort((x, y) => y.n - x.n);
  const hmax = Math.max(1, ...hrows.flatMap((x) => x.a));
  sheets.push({
    name: "Heatmap",
    widths: [60, ...Array(24).fill(5), 8],
    rows: [[`Alert name (hours ${tzAbbrev(tz)})`, ...Array.from({ length: 24 }, (_, i) => String(i)), "Total"], ...hrows.map((x) => [x.t, ...x.a.map((v) => (v ? { v, s: ST.heat0 + Math.min(HEAT_LEVELS - 1, Math.floor((v / hmax) * HEAT_LEVELS)) } : 0)), x.n])],
  });
  const cp: OutCell[][] = [["Dimension", r.p2Short, r.prevShort, r.short, `Change vs ${r.prevShort}`, "Change %"]];
  const cmp = (k: string, f: (x: Aggregate) => number | null) => {
    const c2 = P2 && P2.total ? f(P2) : null,
      pb = P && P.total ? f(P) : null,
      a = f(A);
    cp.push([k, c2, pb, a, pb != null && a != null ? Math.round((a - pb) * 100) / 100 : null, pb ? Math.round(((a! - pb) / pb) * 1000) / 10 : null]);
  };
  cmp("Total cases", (x) => x.total);
  cmp("SLA-evaluable", (x) => x.evaluable);
  ALL_PRIORITIES.forEach((p) => cmp(p, (x) => x.byPrio[p]));
  cmp("Auto-closed", (x) => x.auto);
  cmp("True positives", (x) => x.tp);
  cmp("Uncategorized", (x) => x.uncategorized);
  [...new Set([...Object.keys(A.bucket), ...Object.keys(P?.bucket ?? {}), ...Object.keys(P2?.bucket ?? {})])].forEach((k) => cmp("Bucket: " + k, (x) => x.bucket[k] || 0));
  for (const p of PRIORITIES) for (const m of METRICS) cmp(`SLA ${p} ${m.k} %`, (x) => x.sla[p][m.k].pct);
  cp.push([]);
  cp.push([b("Observations")]);
  r.observations.forEach((o) => cp.push([o]));
  sheets.push({ name: "Comparison", widths: [44, 14, 14, 14, 16, 12], rows: cp });
  return writeXlsx(sheets, { title: `SOC report ${r.client} ${r.label}` });
}

/** Exception report: every flagged item, every edit, and a reconciliation of imported rows to reported cases. */
export async function buildExceptionReport(r: ReportInput): Promise<Blob> {
  const sheets: OutSheet[] = [];
  const excluded = r.cases.filter((c) => c.excluded);
  sheets.push({
    name: "Reconciliation",
    header: false,
    widths: [44, 18],
    rows: [
      [b("Client"), r.client],
      [b("Period"), r.label],
      [b("Imported rows"), r.counts.rows],
      [b("Excluded: created outside the period"), excluded.filter((c) => c.excludedReason === "Created outside the period").length],
      [b("Excluded: dropped in review (duplicates etc.)"), excluded.filter((c) => (c.excludedReason ?? "").startsWith("Dropped")).length],
      [b("Excluded: created time missing or unreadable"), excluded.filter((c) => c.excludedReason === "Created time missing or unreadable").length],
      [b("Excluded: removed from the period in review"), excluded.filter((c) => c.excludedReason === "Excluded in review").length],
      [b("Cases reported"), r.counts.included],
      [b("Check: imported = reported + excluded"), r.counts.rows === r.counts.included + excluded.length ? "OK" : "MISMATCH"],
      [b("SLA-evaluable"), r.counts.evaluable],
      [b("Informational (not in any SLA denominator)"), r.counts.informational],
    ],
  });
  const ex: OutCell[][] = [["Type", "Severity", "Status", "Cases", "Detail", "Rows"]];
  for (const i of r.issues)
    ex.push([
      ISSUE_LABEL[i.type] ?? i.type,
      { v: i.blocking ? "Blocking" : "Non-blocking", s: i.blocking ? ST.bad : ST.warn },
      i.status,
      i.rows.length,
      i.title ?? i.note ?? (i.caseId ? `Case ${i.caseId}${i.field ? " · " + i.field : ""}` : i.key),
      i.rows.slice(0, 50).join(", ") + (i.rows.length > 50 ? "…" : ""),
    ]);
  sheets.push({ name: "Exceptions", filter: true, widths: [26, 14, 12, 8, 70, 40], rows: ex });
  const ed: OutCell[][] = [["When", "Who", "Action", "Case ID", "Row", "Field", "Original value", "New value", "Reason"]];
  for (const e of r.edits) ed.push([e.at, e.actor, e.kind, e.caseId, e.rowNo, e.field, e.oldValue == null ? "" : JSON.stringify(e.oldValue), e.newValue == null ? "" : JSON.stringify(e.newValue), e.reason]);
  sheets.push({ name: "Edit Log", filter: true, widths: [22, 26, 14, 16, 8, 16, 26, 26, 50], rows: ed });
  const xr: OutCell[][] = [["Row", "Case ID", "Title", "Created UTC", "Reason excluded"]];
  for (const c of excluded) xr.push([c.rowNo, c.caseId, c.title, c.ts.createdAt != null && !Number.isNaN(c.ts.createdAt) ? new Date(c.ts.createdAt).toISOString() : "", c.excludedReason ?? ""]);
  sheets.push({ name: "Excluded Records", filter: true, widths: [8, 16, 60, 24, 40], rows: xr });
  const na: OutCell[][] = [["Row", "Case ID", "Metric", "Status", "Reason"]];
  for (const c of r.cases) if (!c.excluded) for (const m of METRICS) if (c.ev[m.k].s === "ERROR" || (c.ev[m.k].why ?? "").startsWith("Voided")) na.push([c.rowNo, c.caseId, m.k, c.ev[m.k].s, c.ev[m.k].why ?? ""]);
  sheets.push({ name: "Data Errors & Voids", filter: true, widths: [8, 16, 8, 10, 60], rows: na });
  return writeXlsx(sheets, { title: `Exception report ${r.client} ${r.label}` });
}

/** The tables behind each slide, for teams that build their own deck. */
export async function buildSlideTables(r: ReportInput): Promise<Blob> {
  const A = r.A;
  const kpi: OutCell[][] = [["Priority", "Cases", ...METRICS.flatMap((m) => [`${m.k} limit`, `${m.k} target %`, `${m.k} actual %`, `${m.k} average`])]];
  for (const p of PRIORITIES) kpi.push([p, A.byPrio[p], ...METRICS.flatMap((m) => [fmtLimit(r.limits[p][m.k]), r.targets[p][m.k], A.sla[p][m.k].pct, A.sla[p][m.k].mean == null ? null : Math.round(A.sla[p][m.k].mean!)])]);
  const funnel: OutCell[][] = [["Stage", "Cases"], [`${r.source} cases generated`, A.total], ["Automated closure", A.auto], ["Tier 1 and 2 investigations", A.tier12], ["Tier 3 investigations", A.tier3], ["Simulation cases", A.simulation]];
  const sev: OutCell[][] = [["Severity", r.short, r.prevShort], ...ALL_PRIORITIES.map((p) => [p, A.byPrio[p], r.P && r.P.total ? r.P.byPrio[p] : null])];
  const keys = [...new Set([...Object.keys(A.bucket), ...Object.keys(r.P?.bucket ?? {}), ...Object.keys(r.P2?.bucket ?? {})])];
  const cat: OutCell[][] = [["Period", ...keys, "Total"], [r.short, ...keys.map((k) => A.bucket[k] || 0), A.total]];
  if (r.P && r.P.total) cat.push([r.prevShort, ...keys.map((k) => r.P!.bucket[k] || 0), r.P.total]);
  if (r.P2 && r.P2.total) cat.push([r.p2Short, ...keys.map((k) => r.P2!.bucket[k] || 0), r.P2.total]);
  const close: OutCell[][] = [["Close reason", "Cases"], ...Object.entries(A.closeR)];
  return writeXlsx([
    { name: "Slide 4 SLA KPIs", rows: kpi, widths: [12, 8, ...Array(16).fill(12)] },
    { name: "Slide 4 Funnel", rows: funnel, widths: [34, 10] },
    { name: "Slide 5 Severity", rows: sev, widths: [16, 12, 12] },
    { name: "Slide 6 Categories", rows: cat, widths: [12, ...keys.map(() => 14), 10] },
    { name: "Slide 7 Close Reasons", rows: close, widths: [20, 10] },
    { name: "Observations", rows: [["Observation"], ...r.observations.map((o) => [o])], widths: [140] },
  ]);
}
