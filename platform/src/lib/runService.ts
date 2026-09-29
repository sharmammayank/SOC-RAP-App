/*
 * Run pipeline (spec §3.2) on Supabase: Upload → Map → Stage → Classify & Validate → Review → Calculate → Publish.
 * The engine runs in the browser; Postgres stores the immutable raw rows, the derived results, the edit log,
 * exceptions and the compliance snapshot. RLS and triggers enforce roles and immutability server-side.
 */
import { supabase, must, fetchAll, inBatches } from "./supabase";
import type { CaseDerivedRow, Client, ExceptionRow, Run, RulesetVersion, ThresholdVersion, CaseEditRow, RunSummary } from "./db";
import { buildCases } from "@/engine/cases";
import { computeRun, reduceEdits, type RunOutput } from "@/engine/run";
import { makeClassifier } from "@/engine/rules";
import type { ColumnMap, Row } from "@/engine/mapping";
import type { AggCase } from "@/engine/aggregate";
import { DEFAULT_SETTINGS, METRIC_KEYS, PRIORITIES, TS_FIELDS, type CaseRecord, type DerivedCase, type Edit, type EngineSettings, type Issue, type Metric, type MetricStatus, type Priority, type TsField } from "@/engine/types";
import type { Period } from "@/engine/periods";
import type { Observation } from "@/engine/analytics";

export const ENGINE_VERSION = "2026.09.1";

export const safeFileName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120) || "upload";

/* ------------------------------------------------------------------ versions */
export async function latestThreshold(clientId: string): Promise<ThresholdVersion> {
  return must(await supabase.from("threshold_versions").select("*").eq("client_id", clientId).order("version_no", { ascending: false }).limit(1).single()) as ThresholdVersion;
}
export async function latestRuleset(clientId: string): Promise<RulesetVersion> {
  return must(await supabase.from("ruleset_versions").select("*").eq("client_id", clientId).eq("status", "published").order("version_no", { ascending: false }).limit(1).single()) as RulesetVersion;
}

/* ------------------------------------------------------------------ step 1: create + upload */
export async function findRunsByHash(clientId: string, hash: string) {
  return must(await supabase.from("runs").select("id,period_start,period_end,status,created_at,source_file_name").eq("client_id", clientId).eq("source_file_hash", hash)) as Pick<Run, "id" | "period_start" | "period_end" | "status" | "created_at" | "source_file_name">[];
}

export async function createRun(p: { client: Client; period: Period; file: File; sha256: string; supersedes?: string | null }): Promise<Run> {
  const run = must(
    await supabase
      .from("runs")
      .insert({ client_id: p.client.id, cadence: p.period.cadence, period_start: p.period.start, period_end: p.period.end, supersedes_run_id: p.supersedes ?? null })
      .select("*")
      .single(),
  ) as Run;
  const path = `${p.client.id}/${run.id}/${safeFileName(p.file.name)}`;
  const up = await supabase.storage.from("uploads").upload(path, p.file, { upsert: false, contentType: p.file.type || "application/octet-stream" });
  if (up.error) {
    await supabase.from("runs").delete().eq("id", run.id);
    throw new Error("The file couldn't be stored: " + up.error.message);
  }
  return must(
    await supabase
      .from("runs")
      .update({ source_file_name: p.file.name.slice(0, 255), source_file_path: path, source_file_hash: p.sha256, source_file_size: p.file.size })
      .eq("id", run.id)
      .select("*")
      .single(),
  ) as Run;
}

/* ------------------------------------------------------------------ step 2: map + stage */
export async function stageRun(
  run: Run,
  client: Client,
  p: { sheet: string; headerRow: number; rows: Row[]; map: ColumnMap; saveProfile: boolean; headers: string[] },
  onProgress?: (done: number, total: number) => void,
) {
  const records = p.rows.map((r, i) => ({ run_id: run.id, row_no: typeof r.__row === "number" ? (r.__row as number) : i + 2, payload: r }));
  await inBatches(records, 1000, async (b) => void must(await supabase.from("case_raw").upsert(b, { onConflict: "run_id,row_no", ignoreDuplicates: true })), 3, (d) => onProgress?.(d, records.length));
  if (p.saveProfile) must(await supabase.from("column_profiles").upsert({ client_id: client.id, mapping: p.map, headers: p.headers.slice(0, 200) }));
  const settings = { periodTz: client.period_tz, displayTz: client.display_tz, ackZero: client.settings.ackZero !== false, engineVersion: ENGINE_VERSION, headerRow: p.headerRow };
  return must(await supabase.from("runs").update({ status: "staged", source_sheet: p.sheet, row_count: records.length, column_map: p.map, settings }).eq("id", run.id).select("*").single()) as Run;
}

/* ------------------------------------------------------------------ edits <-> rows */
export function editToRow(runId: string, e: Edit, meta: { caseId?: string; old?: unknown; reason?: string }) {
  const base = { run_id: runId, kind: e.kind, case_id: meta.caseId ?? null, old_value: meta.old === undefined ? null : meta.old, reason: (meta.reason ?? "").slice(0, 1000) };
  switch (e.kind) {
    case "priority":
      return { ...base, row_no: e.rowNo, field: "priority", new_value: e.value };
    case "timestamp":
      return { ...base, row_no: e.rowNo, field: e.field, new_value: e.value };
    case "void_metric":
      return { ...base, row_no: e.rowNo, field: e.metric, new_value: e.reason, reason: e.reason };
    case "drop":
      return { ...base, row_no: e.rowNo, new_value: true, reason: e.reason };
    case "restore":
      return { ...base, row_no: e.rowNo, new_value: false };
    case "category":
      return { ...base, target_key: e.norm, new_value: { category: e.category, bucket: e.bucket } };
    case "accept":
      return { ...base, target_key: e.key, new_value: true, reason: e.reason ?? meta.reason ?? "" };
    case "period":
      return { ...base, row_no: e.rowNo, new_value: e.include };
  }
}
export function rowToEdit(r: CaseEditRow): Edit | null {
  const nv = r.new_value as any;
  switch (r.kind) {
    case "priority":
      return r.row_no != null ? { kind: "priority", rowNo: r.row_no, value: nv as Priority } : null;
    case "timestamp":
      return r.row_no != null && TS_FIELDS.includes(r.field as TsField) ? { kind: "timestamp", rowNo: r.row_no, field: r.field as TsField, value: typeof nv === "number" ? nv : null } : null;
    case "void_metric":
      return r.row_no != null && METRIC_KEYS.includes(r.field as Metric) ? { kind: "void_metric", rowNo: r.row_no, metric: r.field as Metric, reason: r.reason || String(nv ?? "") } : null;
    case "drop":
      return r.row_no != null ? { kind: "drop", rowNo: r.row_no, reason: r.reason } : null;
    case "restore":
      return r.row_no != null ? { kind: "restore", rowNo: r.row_no } : null;
    case "category":
      return r.target_key && nv ? { kind: "category", norm: r.target_key, category: String(nv.category), bucket: String(nv.bucket) } : null;
    case "accept":
      return r.target_key ? { kind: "accept", key: r.target_key, reason: r.reason } : null;
    case "period":
      return r.row_no != null ? { kind: "period", rowNo: r.row_no, include: nv === true } : null;
  }
  return null;
}

/* ------------------------------------------------------------------ derived <-> rows */
const iso = (ms: number | null) => (ms == null || Number.isNaN(ms) ? null : new Date(ms).toISOString());
export function derivedToRow(runId: string, d: DerivedCase): Omit<CaseDerivedRow, never> {
  const unreadable = TS_FIELDS.filter((k) => d.ts[k] != null && Number.isNaN(d.ts[k] as number));
  const m = (k: Metric) => d.ev[k];
  const sec = (k: Metric) => {
    const el = m(k).el;
    return el == null ? null : Math.round(el * 1000) / 1000;
  };
  return {
    run_id: runId,
    row_no: d.rowNo,
    case_id: d.caseId,
    title: d.title,
    title_normalized: d.norm,
    category: d.category,
    subcategory: d.subcategory,
    report_bucket: d.bucket,
    matched_rule_id: d.ruleId,
    matched_text: d.match,
    priority: d.priority,
    prio_note: d.prioNote,
    created_at: iso(d.ts.createdAt),
    assigned_at: iso(d.ts.assignedAt),
    investigated_till: iso(d.ts.investigatedTill),
    containment_at: iso(d.ts.containmentAt),
    closed_at: iso(d.ts.closedAt),
    disposition: d.disposition,
    close_reason: d.closeReason,
    root_cause: d.rootCause,
    assignee: d.assignee,
    stage: d.stage,
    is_open: d.isOpen,
    in_period: d.inPeriod,
    excluded: d.excluded,
    excluded_reason: d.excludedReason,
    tta_sec: sec("TTA"),
    tti_sec: sec("TTI"),
    ttc_sec: sec("TTC"),
    ttr_sec: sec("TTR"),
    tta_status: m("TTA").s,
    tti_status: m("TTI").s,
    ttc_status: m("TTC").s,
    ttr_status: m("TTR").s,
    tta_note: m("TTA").why ?? null,
    tti_note: m("TTI").why ?? null,
    ttc_note: m("TTC").why ?? null,
    ttr_note: m("TTR").why ?? null,
    tta_imputed: !!m("TTA").imputed,
    dq_note: unreadable.length ? `Unreadable: ${unreadable.join(", ")}` : "",
  };
}
const ms = (s: string | null) => (s ? Date.parse(s) : null);
/** A stored derived row as the aggregation input, with the statuses exactly as they were calculated. */
export function rowToAgg(r: CaseDerivedRow): AggCase & { runId: string; rowNo: number; excluded: boolean; ts: Record<TsField, number | null> } {
  const ev = {} as AggCase["ev"];
  for (const k of METRIC_KEYS) {
    const lk = k.toLowerCase() as "tta";
    ev[k] = { s: r[`${lk}_status`] as MetricStatus, el: r[`${lk}_sec`] == null ? null : Number(r[`${lk}_sec`]), why: r[`${lk}_note`] ?? undefined, imputed: k === "TTA" ? r.tta_imputed : false };
  }
  return {
    runId: r.run_id,
    rowNo: r.row_no,
    caseId: r.case_id,
    title: r.title,
    category: r.category,
    subcategory: r.subcategory,
    bucket: r.report_bucket,
    priority: (r.priority as Priority) ?? null,
    ts: { createdAt: ms(r.created_at), assignedAt: ms(r.assigned_at), investigatedTill: ms(r.investigated_till), containmentAt: ms(r.containment_at), closedAt: ms(r.closed_at) },
    disposition: r.disposition,
    closeReason: r.close_reason,
    rootCause: r.root_cause,
    assignee: r.assignee,
    isOpen: r.is_open,
    excluded: r.excluded,
    ev,
  };
}

/* ------------------------------------------------------------------ review context */
export interface RunContext {
  run: Run;
  client: Client;
  threshold: ThresholdVersion;
  ruleset: RulesetVersion;
  cases: CaseRecord[];
  raw: Map<number, Row>;
  editRows: CaseEditRow[];
  edits: Edit[];
  settings: EngineSettings;
  period: Period;
  classifier: ReturnType<typeof makeClassifier>;
  /** Fingerprints of the derived rows last written, to upsert only what changed. */
  persisted: Map<number, string>;
  storedExceptions: Map<string, ExceptionRow>;
}

export async function loadRunContext(runId: string, onProgress?: (msg: string) => void): Promise<RunContext> {
  const run = must(await supabase.from("runs").select("*").eq("id", runId).single()) as Run;
  const client = must(await supabase.from("clients").select("*").eq("id", run.client_id).single()) as Client;
  const threshold = run.threshold_version_id
    ? (must(await supabase.from("threshold_versions").select("*").eq("id", run.threshold_version_id).single()) as ThresholdVersion)
    : await latestThreshold(client.id);
  const ruleset = run.ruleset_version_id ? (must(await supabase.from("ruleset_versions").select("*").eq("id", run.ruleset_version_id).single()) as RulesetVersion) : await latestRuleset(client.id);
  onProgress?.("Loading uploaded rows…");
  const rawRows = await fetchAll<{ row_no: number; payload: Row }>((f, t) => supabase.from("case_raw").select("row_no,payload").eq("run_id", runId).order("row_no").range(f, t), 1000, (n) => onProgress?.(`Loading uploaded rows… ${n.toLocaleString()}`));
  const settings: EngineSettings = {
    ...DEFAULT_SETTINGS,
    periodTz: run.settings.periodTz ?? client.period_tz,
    displayTz: run.settings.displayTz ?? client.display_tz,
    ackZero: run.settings.ackZero ?? client.settings.ackZero !== false,
    uncategorizedWarnPct: client.settings.uncategorizedWarnPct ?? 5,
  };
  const map = run.column_map ?? {};
  const payloads = rawRows.map((r) => ({ ...r.payload, __row: r.row_no }) as Row);
  const cases = buildCases(payloads, map, settings.periodTz);
  const editRows = (await fetchAll<CaseEditRow>((f, t) => supabase.from("case_edits").select("*").eq("run_id", runId).order("id").range(f, t))) ?? [];
  const edits = editRows.map(rowToEdit).filter((x): x is Edit => !!x);
  onProgress?.("Loading previous results…");
  const persisted = new Map<number, string>();
  if (run.status !== "draft" && run.status !== "staged") {
    const der = await fetchAll<CaseDerivedRow>((f, t) => supabase.from("case_derived").select("*").eq("run_id", runId).order("row_no").range(f, t));
    for (const d of der) persisted.set(d.row_no, fingerprint(d));
  }
  const exc = (must(await supabase.from("exceptions").select("*").eq("run_id", runId)) as ExceptionRow[]) ?? [];
  return {
    run,
    client,
    threshold,
    ruleset,
    cases,
    raw: new Map(payloads.map((p) => [p.__row as number, p])),
    editRows,
    edits,
    settings,
    period: { cadence: run.cadence, start: run.period_start, end: run.period_end },
    classifier: makeClassifier(ruleset.rules, true),
    persisted,
    storedExceptions: new Map(exc.map((e) => [e.key, e])),
  };
}

const fingerprint = (r: CaseDerivedRow) => {
  // Normalize numeric strings from Postgres so unchanged rows compare equal.
  const o: Record<string, unknown> = { ...r };
  for (const k of ["tta_sec", "tti_sec", "ttc_sec", "ttr_sec"]) o[k] = o[k] == null ? null : Math.round(Number(o[k]) * 1000) / 1000;
  for (const k of ["created_at", "assigned_at", "investigated_till", "containment_at", "closed_at"]) o[k] = o[k] == null ? null : new Date(o[k] as string).toISOString();
  return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
};

export function compute(ctx: RunContext): RunOutput {
  return computeRun({ cases: ctx.cases, edits: ctx.edits, limits: ctx.threshold.limits, targets: ctx.threshold.targets, rules: ctx.ruleset.rules, settings: ctx.settings, period: ctx.period, classifier: ctx.classifier });
}

export function summaryOf(out: RunOutput): RunSummary {
  let breaches = 0,
    attained = 0,
    targetsTotal = 0;
  for (const p of PRIORITIES)
    for (const m of METRIC_KEYS) {
      const c = out.agg.sla[p][m];
      if (c.status === "none") continue;
      targetsTotal++;
      if (c.status === "ok") attained++;
      else breaches++;
    }
  return {
    ...out.counts,
    total: out.agg.total,
    overall: Object.fromEntries(METRIC_KEYS.map((m) => [m, out.agg.overall[m].pct])),
    breaches,
    attained,
    targetsTotal,
    engineVersion: ENGINE_VERSION,
  };
}

function issueToException(runId: string, i: Issue, accepted: boolean): Omit<ExceptionRow, "updated_at"> {
  return {
    run_id: runId,
    key: i.key.slice(0, 1000),
    type: i.type,
    severity: i.blocking ? "blocking" : "non_blocking",
    status: accepted ? "accepted" : "open",
    case_count: i.rows.length,
    rows: i.rows.slice(0, 5000),
    detail: { title: i.title ?? null, norm: i.norm ?? null, field: i.field ?? null, metric: i.metric ?? null, note: i.note ?? null, caseId: i.caseId ?? null },
  };
}

/**
 * Classify + validate + calculate, then persist only what changed: derived rows, the exception set
 * (issues that disappeared are marked resolved) and the run summary. The run moves to `review`.
 */
export async function recalcAndPersist(ctx: RunContext, onProgress?: (msg: string) => void): Promise<RunOutput> {
  const out = compute(ctx);
  const changed: CaseDerivedRow[] = [];
  const fresh = new Map<number, string>();
  for (const d of out.derived) {
    const row = derivedToRow(ctx.run.id, d);
    const fp = fingerprint(row);
    fresh.set(d.rowNo, fp);
    if (ctx.persisted.get(d.rowNo) !== fp) changed.push(row);
  }
  if (changed.length) {
    onProgress?.(`Saving ${changed.length.toLocaleString()} changed case${changed.length === 1 ? "" : "s"}…`);
    await inBatches(changed, 500, async (b) => void must(await supabase.from("case_derived").upsert(b, { onConflict: "run_id,row_no" })), 3);
  }
  ctx.persisted = fresh;
  const st = reduceEdits(ctx.edits);
  const current = out.issues.map((i) => issueToException(ctx.run.id, i, st.accepted.has(i.key)));
  const curKeys = new Set(current.map((e) => e.key));
  const resolved = [...ctx.storedExceptions.values()].filter((e) => !curKeys.has(e.key) && e.status !== "resolved").map((e) => ({ ...e, status: "resolved" as const, updated_at: new Date().toISOString() }));
  const changedExc = current.filter((e) => {
    const s = ctx.storedExceptions.get(e.key);
    return !s || s.status !== e.status || s.case_count !== e.case_count || JSON.stringify(s.rows) !== JSON.stringify(e.rows);
  });
  const excWrites = [...changedExc.map((e) => ({ ...e, updated_at: new Date().toISOString() })), ...resolved];
  if (excWrites.length) await inBatches(excWrites, 500, async (b) => void must(await supabase.from("exceptions").upsert(b, { onConflict: "run_id,key" })), 2);
  for (const e of excWrites) ctx.storedExceptions.set(e.key, e as ExceptionRow);
  const patch: Partial<Run> = { summary: summaryOf(out) };
  if (ctx.run.status === "staged" || ctx.run.status === "draft") patch.status = "review";
  if (ctx.run.threshold_version_id !== ctx.threshold.id) patch.threshold_version_id = ctx.threshold.id;
  if (ctx.run.ruleset_version_id !== ctx.ruleset.id) patch.ruleset_version_id = ctx.ruleset.id;
  ctx.run = must(await supabase.from("runs").update(patch).eq("id", ctx.run.id).select("*").single()) as Run;
  return out;
}

/** Appends a review decision to the audit log, then re-evaluates (spec AT-08). */
export async function recordEdits(ctx: RunContext, items: { edit: Edit; caseId?: string; old?: unknown; reason?: string }[]) {
  if (!items.length) return;
  const rows = items.map((i) => editToRow(ctx.run.id, i.edit, i));
  const saved = [] as CaseEditRow[];
  await inBatches(rows, 500, async (b) => void saved.push(...(must(await supabase.from("case_edits").insert(b).select("*")) as CaseEditRow[])), 1);
  ctx.editRows.push(...saved);
  ctx.edits.push(...items.map((i) => i.edit));
}

/** Switches the run to the newest threshold and rule-set versions (an explicit, logged action). */
export async function adoptLatestVersions(ctx: RunContext) {
  ctx.threshold = await latestThreshold(ctx.client.id);
  ctx.ruleset = await latestRuleset(ctx.client.id);
  ctx.classifier = makeClassifier(ctx.ruleset.rules, true);
}

/* ------------------------------------------------------------------ publish */
export async function publishRun(ctx: RunContext, out: RunOutput, observations: Observation[], reportText: Record<string, string>) {
  if (out.counts.blockingOpen > 0) throw new Error(`${out.counts.blockingOpen} blocking exception(s) are still open.`);
  const snaps = [] as Record<string, unknown>[];
  const cellRow = (priority: string, metric: Metric, c: RunOutput["agg"]["overall"]["TTA"]) => ({
    run_id: ctx.run.id,
    priority,
    metric,
    met: c.met,
    not_met: c.notMet,
    pending: c.pending,
    na: c.na,
    data_error: c.err,
    zero_imputed: c.zero,
    compliance_pct: c.pct,
    target_pct: c.target,
    variance_pts: c.variance,
    status: c.status,
    mean_sec: c.mean,
    median_sec: c.median,
    p95_sec: c.p95,
    worst: c.worst,
  });
  for (const p of PRIORITIES) for (const m of METRIC_KEYS) snaps.push(cellRow(p, m, out.agg.sla[p][m]));
  for (const m of METRIC_KEYS) snaps.push(cellRow("All", m, out.agg.overall[m]));
  must(await supabase.from("metric_snapshots").upsert(snaps, { onConflict: "run_id,priority,metric" }));
  must(
    await supabase
      .from("runs")
      .update({
        aggregate: out.agg,
        observations: observations.map((o) => ({ kind: o.kind, text: o.text, basis: o.basis, include: (o as any).include !== false })),
        report_text: reportText,
        summary: summaryOf(out),
      })
      .eq("id", ctx.run.id),
  );
  must(await supabase.rpc("publish_run", { p_run: ctx.run.id }));
  ctx.run = must(await supabase.from("runs").select("*").eq("id", ctx.run.id).single()) as Run;
}

/* ------------------------------------------------------------------ reading results for analytics */
const DERIVED_COLS =
  "run_id,row_no,case_id,title,category,subcategory,report_bucket,priority,created_at,assigned_at,investigated_till,containment_at,closed_at,disposition,close_reason,root_cause,assignee,is_open,excluded,tta_sec,tti_sec,ttc_sec,ttr_sec,tta_status,tti_status,ttc_status,ttr_status,tta_note,tti_note,ttc_note,ttr_note,tta_imputed";

/**
 * Cases for a client over a time window, from published runs (plus optionally one run in review).
 * The same case ID in two runs keeps the copy from the run with the later period (then the later publish).
 */
export async function loadClientCases(clientId: string, from: number, to: number, opts: { includeRunId?: string; onProgress?: (n: number) => void } = {}) {
  const fromD = new Date(from - 86400000).toISOString().slice(0, 10),
    toD = new Date(to + 86400000).toISOString().slice(0, 10);
  const runs = must(
    await supabase.from("runs").select("id,period_start,period_end,published_at,status,cadence").eq("client_id", clientId).lte("period_start", toD).gte("period_end", fromD).in("status", ["published", "review"]),
  ) as Pick<Run, "id" | "period_start" | "period_end" | "published_at" | "status" | "cadence">[];
  const use = runs.filter((r) => r.status === "published" || r.id === opts.includeRunId);
  const rank = new Map(use.map((r) => [r.id, `${r.period_end}|${r.status === "review" ? "9" : r.published_at ?? ""}`]));
  const all: ReturnType<typeof rowToAgg>[] = [];
  for (const r of use) {
    const rows = await fetchAll<CaseDerivedRow>(
      (f, t) =>
        supabase
          .from("case_derived")
          .select(DERIVED_COLS)
          .eq("run_id", r.id)
          .eq("excluded", false)
          .gte("created_at", new Date(from).toISOString())
          .lt("created_at", new Date(to).toISOString())
          .order("row_no")
          .range(f, t) as any,
      1000,
      (n) => opts.onProgress?.(all.length + n),
    );
    all.push(...rows.map(rowToAgg));
  }
  const best = new Map<string, ReturnType<typeof rowToAgg>>();
  const noId: ReturnType<typeof rowToAgg>[] = [];
  for (const c of all) {
    if (!c.caseId) {
      noId.push(c);
      continue;
    }
    const cur = best.get(c.caseId);
    if (!cur || rank.get(c.runId)! > rank.get(cur.runId)!) best.set(c.caseId, c);
  }
  return { cases: [...best.values(), ...noId], runs: use };
}
