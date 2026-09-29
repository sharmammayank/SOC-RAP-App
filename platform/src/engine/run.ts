import type {
  CaseRecord,
  Classification,
  DerivedCase,
  Edit,
  EngineSettings,
  Issue,
  Limits,
  Metric,
  MetricResult,
  Priority,
  Rule,
  Targets,
  TsField,
} from "./types";
import { METRIC_KEYS, TS_FIELDS } from "./types";
import { makeClassifier, normTitle } from "./rules";
import { resolvePriority } from "./cases";
import { periodRange, type Period } from "./periods";
import { aggregate, type Aggregate } from "./aggregate";

/** Latest decision per key, reduced from the append-only edit log. */
export interface EditState {
  priority: Map<number, Priority>;
  ts: Map<number, Partial<Record<TsField, number | null>>>;
  voids: Map<string, string>;
  dropped: Map<number, string>;
  category: Map<string, { category: string; bucket: string }>;
  accepted: Map<string, string>;
  period: Map<number, boolean>;
}
export function reduceEdits(edits: Edit[]): EditState {
  const s: EditState = { priority: new Map(), ts: new Map(), voids: new Map(), dropped: new Map(), category: new Map(), accepted: new Map(), period: new Map() };
  for (const e of edits) {
    switch (e.kind) {
      case "priority":
        s.priority.set(e.rowNo, e.value);
        break;
      case "timestamp":
        s.ts.set(e.rowNo, { ...(s.ts.get(e.rowNo) ?? {}), [e.field]: e.value });
        break;
      case "void_metric":
        s.voids.set(`${e.rowNo}:${e.metric}`, e.reason);
        break;
      case "drop":
        s.dropped.set(e.rowNo, e.reason);
        break;
      case "restore":
        s.dropped.delete(e.rowNo);
        break;
      case "category":
        s.category.set(e.norm, { category: e.category, bucket: e.bucket });
        break;
      case "accept":
        s.accepted.set(e.key, e.reason ?? "");
        break;
      case "period":
        s.period.set(e.rowNo, e.include);
        break;
    }
  }
  return s;
}

const AUTO = /automated closure/i;
export const isAutoClosed = (rootCause: string) => AUTO.test(rootCause);

/** Per-metric status (spec §5.2): MET, NOT_MET, PENDING (open, within limit), NA, ERROR (data error). */
export function evaluateCase(
  c: CaseRecord,
  ts: Record<TsField, number | null>,
  priority: Priority | null,
  editedTs: boolean,
  limits: Limits,
  settings: EngineSettings,
  asOf: number,
  voids: Map<string, string>,
  dropped: boolean,
): Record<Metric, MetricResult> {
  const out = {} as Record<Metric, MetricResult>;
  const created = ts.createdAt;
  const open = ts.closedAt == null && c.isClosedFlag !== true;
  const auto = isAutoClosed(c.rootCause);
  const derived: Record<Metric, number | null> = {
    TTA: ts.assignedAt != null && created != null ? (ts.assignedAt - created) / 1000 : null,
    // With no investigation milestone, investigation is taken to end at closure (matches the manual workbook).
    TTI: created == null ? null : ts.investigatedTill != null ? (ts.investigatedTill - created) / 1000 : ts.closedAt != null ? (ts.closedAt - created) / 1000 : null,
    TTC: ts.containmentAt != null && created != null ? (ts.containmentAt - created) / 1000 : null,
    TTR: ts.closedAt != null && created != null ? (ts.closedAt - created) / 1000 : null,
  };
  const chrono = ts.assignedAt != null && ts.closedAt != null && ts.closedAt < ts.assignedAt;
  for (const k of METRIC_KEYS) {
    if (dropped) {
      out[k] = { s: "NA", why: "Dropped duplicate" };
      continue;
    }
    if (created == null || Number.isNaN(created)) {
      out[k] = { s: "ERROR", why: "Created time missing or unreadable" };
      continue;
    }
    if (!priority) {
      out[k] = { s: "ERROR", why: "Priority not recognized" };
      continue;
    }
    if (priority === "Informational") {
      out[k] = { s: "NA", why: "Informational (excluded)" };
      continue;
    }
    const v = voids.get(`${c.rowNo}:${k}`);
    if (v) {
      out[k] = { s: "NA", why: "Voided: " + v };
      continue;
    }
    const tsVal = ts[k === "TTA" ? "assignedAt" : k === "TTI" ? "investigatedTill" : k === "TTC" ? "containmentAt" : "closedAt"];
    if (tsVal != null && Number.isNaN(tsVal)) {
      out[k] = { s: "ERROR", why: "Milestone timestamp unreadable" };
      continue;
    }
    if (k === "TTI" && ts.investigatedTill == null && ts.closedAt != null && Number.isNaN(ts.closedAt)) {
      out[k] = { s: "ERROR", why: "Closed timestamp unreadable" };
      continue;
    }
    if (k === "TTA" && chrono) {
      out[k] = { s: "ERROR", why: "Closed before acknowledged" };
      continue;
    }
    const lim = limits[priority][k].seconds;
    // A supplied elapsed value wins unless the reviewer edited the timestamps.
    const el = !editedTs && c.supplied[k] != null ? c.supplied[k] : derived[k];
    if (el == null) {
      if (k === "TTA" && settings.ackZero) {
        out[k] = { s: "MET", el: 0, imputed: true, why: auto ? "No acknowledge time (automated closure): counted as 0 s" : "No acknowledge time: counted as 0 s" };
        continue;
      }
      if (k === "TTA" && auto) {
        out[k] = { s: "NA", why: "Automated closure" };
        continue;
      }
      if (k === "TTC") {
        out[k] = { s: "NA", why: "No containment recorded" };
        continue;
      }
      if (open && k === "TTR") {
        const age = (asOf - created) / 1000;
        out[k] = age > lim ? { s: "NOT_MET", why: "Open past limit", el: null } : { s: "PENDING", why: "Open, within limit" };
        continue;
      }
      out[k] = { s: "NA", why: open ? "Not recorded (case still open)" : "No milestone recorded" };
      continue;
    }
    if (el < 0) {
      out[k] = { s: "ERROR", why: "Negative elapsed time" };
      continue;
    }
    out[k] = { s: el <= lim ? "MET" : "NOT_MET", el };
  }
  return out;
}

export interface RunInput {
  cases: CaseRecord[];
  edits: Edit[];
  limits: Limits;
  targets: Targets;
  rules: Rule[];
  settings: EngineSettings;
  period: Period;
  /** Classifier to reuse between recomputations (titles are cached inside it). */
  classifier?: ReturnType<typeof makeClassifier>;
}
export interface RunOutput {
  derived: DerivedCase[];
  issues: Issue[];
  agg: Aggregate;
  asOf: number;
  counts: {
    rows: number;
    inPeriod: number;
    outOfPeriod: number;
    included: number;
    dropped: number;
    evaluable: number;
    informational: number;
    uncategorized: number;
    uncategorizedPct: number;
    blockingOpen: number;
    nonBlockingOpen: number;
  };
  rejectedRules: { rule_id: string; error: string }[];
}

export function computeRun(inp: RunInput): RunOutput {
  const st = reduceEdits(inp.edits);
  const clf = inp.classifier ?? makeClassifier(inp.rules, true);
  const { from, to } = periodRange(inp.period, inp.settings.periodTz);
  let maxTs = 0;
  for (const c of inp.cases) for (const k of TS_FIELDS) {
    const v = st.ts.get(c.rowNo)?.[k] ?? c.ts[k];
    if (v != null && !Number.isNaN(v) && v > maxTs) maxTs = v;
  }
  const asOf = Math.min(to, maxTs || to);
  const derived: DerivedCase[] = [];
  const cls = new Map<number, Classification>();
  for (const c of inp.cases) {
    const tsEdit = st.ts.get(c.rowNo);
    const ts = tsEdit ? { ...c.ts, ...tsEdit } : c.ts;
    const rp = resolvePriority(c);
    const pe = st.priority.get(c.rowNo);
    const priority = pe ?? rp.priority;
    const norm = normTitle(c.title);
    const ov = st.category.get(norm);
    const cl: Classification = ov ? { ruleId: "MANUAL", category: ov.category, sub: "Manual assignment", bucket: ov.bucket, match: "" } : clf.classify(c.title, c.description);
    cls.set(c.rowNo, cl);
    const created = ts.createdAt;
    const inPeriod = created != null && !Number.isNaN(created) && created >= from && created < to;
    const dropped = st.dropped.has(c.rowNo);
    const includeOverride = st.period.get(c.rowNo);
    let excluded = false,
      excludedReason = "";
    if (dropped) {
      excluded = true;
      excludedReason = "Dropped: " + st.dropped.get(c.rowNo);
    } else if (created == null || Number.isNaN(created)) {
      excluded = true;
      excludedReason = "Created time missing or unreadable";
    } else if (!inPeriod && includeOverride !== true) {
      excluded = true;
      excludedReason = "Created outside the period";
    } else if (inPeriod && includeOverride === false) {
      excluded = true;
      excludedReason = "Excluded in review";
    }
    const ev = evaluateCase(c, ts, priority, !!tsEdit, inp.limits, inp.settings, asOf, st.voids, dropped);
    derived.push({
      rowNo: c.rowNo,
      caseId: c.id,
      title: c.title,
      norm,
      category: cl.category,
      subcategory: cl.sub,
      bucket: cl.bucket,
      ruleId: cl.ruleId,
      match: cl.match,
      priority,
      prioNote: pe ? "" : rp.note,
      ts,
      disposition: c.disposition,
      closeReason: c.closeReason,
      rootCause: c.rootCause,
      assignee: c.assignee,
      stage: c.stage,
      isOpen: ts.closedAt == null && c.isClosedFlag !== true,
      inPeriod,
      excluded,
      excludedReason,
      ev,
    });
  }
  const issues = buildIssues(inp.cases, derived, cls, st);
  const included = derived.filter((d) => !d.excluded);
  const agg = aggregate(included, { targets: inp.targets, from, to, settings: inp.settings });
  const blockingOpen = issues.filter((i) => i.blocking).length;
  const nonBlockingOpen = issues.filter((i) => !i.blocking && !st.accepted.has(i.key)).length;
  const informational = included.filter((d) => d.priority === "Informational").length;
  return {
    derived,
    issues,
    agg,
    asOf,
    counts: {
      rows: inp.cases.length,
      inPeriod: derived.filter((d) => d.inPeriod).length,
      outOfPeriod: derived.filter((d) => !d.inPeriod && d.ts.createdAt != null && !Number.isNaN(d.ts.createdAt)).length,
      included: included.length,
      dropped: st.dropped.size,
      evaluable: agg.evaluable,
      informational,
      uncategorized: agg.uncategorized,
      uncategorizedPct: agg.total ? (agg.uncategorized / agg.total) * 100 : 0,
      blockingOpen,
      nonBlockingOpen,
    },
    rejectedRules: clf.rejected,
  };
}

/** Exception queue (spec §4.5). Blocking issues disappear once fixed; non-blocking ones stay and can be accepted. */
export function buildIssues(cases: CaseRecord[], derived: DerivedCase[], cls: Map<number, Classification>, st: EditState): Issue[] {
  const issues: Issue[] = [];
  const byRow = new Map(derived.map((d) => [d.rowNo, d]));
  const scope = (d: DerivedCase) => !d.excluded || d.excludedReason === "Created time missing or unreadable";
  // Uncategorized, grouped by normalized title so one decision resolves many rows.
  const groups = new Map<string, DerivedCase[]>();
  const ambig = new Map<string, DerivedCase[]>();
  for (const d of derived) {
    if (!scope(d)) continue;
    if (d.category === "Uncategorized") {
      if (!groups.has(d.norm)) groups.set(d.norm, []);
      groups.get(d.norm)!.push(d);
    } else if (cls.get(d.rowNo)?.ambiguous) {
      if (!ambig.has(d.norm)) ambig.set(d.norm, []);
      ambig.get(d.norm)!.push(d);
    }
  }
  for (const [n, ds] of groups) issues.push({ key: "UNCAT:" + n, type: "UNCAT", blocking: false, rows: ds.map((d) => d.rowNo), title: ds[0].title, norm: n });
  for (const [n, ds] of ambig)
    issues.push({ key: "AMBIG:" + n, type: "AMBIG", blocking: false, rows: ds.map((d) => d.rowNo), title: ds[0].title, norm: n, note: `${ds[0].ruleId} chosen over ${(cls.get(ds[0].rowNo)?.alsoMatched ?? []).join(", ")}` });
  for (const d of derived) {
    if (!scope(d) || d.ev.TTA.why === "Dropped duplicate") continue;
    if (!d.priority) issues.push({ key: "PRIO:" + d.rowNo, type: "PRIO", blocking: true, rows: [d.rowNo], caseId: d.caseId });
  }
  const fixes = new Map<string, number[]>();
  for (const d of derived) {
    if (!scope(d) || !d.prioNote) continue;
    if (!fixes.has(d.prioNote)) fixes.set(d.prioNote, []);
    fixes.get(d.prioNote)!.push(d.rowNo);
  }
  for (const [note, rows] of fixes) issues.push({ key: "PFIX:" + note, type: "PFIX", blocking: false, rows, note });
  for (const d of derived) {
    if (!scope(d)) continue;
    const ts = d.ts;
    if (ts.assignedAt != null && ts.closedAt != null && ts.closedAt < ts.assignedAt && !st.voids.has(`${d.rowNo}:TTA`))
      issues.push({ key: "CHRONO:" + d.rowNo, type: "CHRONO", blocking: true, rows: [d.rowNo], caseId: d.caseId, field: "assignedAt", metric: "TTA" });
    const pairs: [TsField, Metric][] = [
      ["assignedAt", "TTA"],
      ["investigatedTill", "TTI"],
      ["containmentAt", "TTC"],
      ["closedAt", "TTR"],
    ];
    for (const [k, m] of pairs) {
      const v = ts[k];
      if (v != null && !Number.isNaN(v) && ts.createdAt != null && !Number.isNaN(ts.createdAt) && v < ts.createdAt - 1000 && !st.voids.has(`${d.rowNo}:${m}`))
        issues.push({ key: `NEG:${d.rowNo}:${k}`, type: "NEG", blocking: true, rows: [d.rowNo], caseId: d.caseId, field: k, metric: m });
    }
    for (const k of TS_FIELDS) {
      const v = ts[k];
      if (v != null && Number.isNaN(v)) {
        const m: Metric | undefined = k === "assignedAt" ? "TTA" : k === "investigatedTill" ? "TTI" : k === "containmentAt" ? "TTC" : k === "closedAt" ? "TTR" : undefined;
        if (m && st.voids.has(`${d.rowNo}:${m}`)) continue;
        issues.push({ key: `TS:${d.rowNo}:${k}`, type: "TS", blocking: true, rows: [d.rowNo], caseId: d.caseId, field: k, metric: m });
      }
    }
  }
  // Duplicate case IDs within the upload.
  const byId = new Map<string, number[]>();
  for (const c of cases) {
    if (!c.id || st.dropped.has(c.rowNo)) continue;
    if (!byId.has(c.id)) byId.set(c.id, []);
    byId.get(c.id)!.push(c.rowNo);
  }
  for (const [id, rows] of byId) if (rows.length > 1 && rows.some((r) => scope(byRow.get(r)!))) issues.push({ key: "DUP:" + id, type: "DUP", blocking: true, rows, caseId: id });
  // Records outside the declared window are flagged, never silently dropped (spec §4.4).
  const out = derived.filter((d) => !d.inPeriod && !st.dropped.has(d.rowNo) && d.ts.createdAt != null && !Number.isNaN(d.ts.createdAt));
  if (out.length) issues.push({ key: "OUT", type: "OUT", blocking: false, rows: out.map((d) => d.rowNo), note: `${out.length} case${out.length > 1 ? "s were" : " was"} created outside the period` });
  return issues;
}

export const ISSUE_ORDER: Record<string, number> = { PRIO: 0, DUP: 1, CHRONO: 2, NEG: 3, TS: 4, OUT: 5, PFIX: 6, AMBIG: 7, UNCAT: 8 };
export const ISSUE_LABEL: Record<string, string> = {
  PRIO: "Invalid priority",
  DUP: "Duplicate case ID",
  CHRONO: "Chronology inversion",
  NEG: "Negative elapsed time",
  TS: "Unreadable timestamp",
  OUT: "Out-of-period records",
  PFIX: "Priority corrected",
  AMBIG: "Ambiguous category match",
  UNCAT: "Uncategorized title",
};
