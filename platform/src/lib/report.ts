import { supabase, must } from "./supabase";
import { loadClientCases, type RunContext } from "./runService";
import type { RunOutput } from "@/engine/run";
import { reduceEdits } from "@/engine/run";
import { aggregate, type Aggregate } from "@/engine/aggregate";
import { periodLabel, periodRange, previousPeriod, shortPeriodLabel, type Period } from "@/engine/periods";
import type { ReportInput } from "@/engine/export/workbook";
import { observations as makeObservations, DEFAULT_MATERIALITY, type Observation } from "@/engine/analytics";
import { tzAbbrev } from "@/engine/tz";
import type { Profile } from "./db";

export interface Comparison {
  P: Aggregate | null;
  P2: Aggregate | null;
  prev: Period;
  prev2: Period;
}

/** The two preceding periods of the same cadence, built from published runs (spec §6.2 default comparison). */
export async function loadComparison(ctx: RunContext): Promise<Comparison> {
  const prev = previousPeriod(ctx.period),
    prev2 = previousPeriod(prev);
  const agg = async (p: Period) => {
    const w = periodRange(p, ctx.settings.periodTz);
    const { cases } = await loadClientCases(ctx.client.id, w.from, w.to);
    const own = cases.filter((c) => c.runId !== ctx.run.id);
    return own.length ? aggregate(own, { targets: ctx.threshold.targets, from: w.from, to: w.to, settings: ctx.settings }) : null;
  };
  const [P, P2] = await Promise.all([agg(prev), agg(prev2)]);
  return { P, P2, prev, prev2 };
}

export function runObservations(ctx: RunContext, out: RunOutput, cmp: Comparison | null): Observation[] {
  return makeObservations({
    A: out.agg,
    P: cmp?.P ?? null,
    cur: out.derived.filter((d) => !d.excluded),
    curLabel: periodLabel(ctx.period),
    prevLabel: cmp ? periodLabel(cmp.prev) : "the previous period",
    source: ctx.client.source_label || "SOC",
    displayTz: ctx.settings.displayTz,
    tzLabel: tzAbbrev(ctx.settings.displayTz),
    materiality: ctx.client.settings.materiality ?? DEFAULT_MATERIALITY,
  });
}

let profileCache: Map<string, string> | null = null;
export async function actorNames(): Promise<Map<string, string>> {
  if (profileCache) return profileCache;
  const rows = must(await supabase.from("profiles").select("id,email,full_name")) as Pick<Profile, "id" | "email" | "full_name">[];
  profileCache = new Map(rows.map((r) => [r.id, r.full_name || r.email]));
  return profileCache;
}

export async function buildReportInput(ctx: RunContext, out: RunOutput, cmp: Comparison | null, observationTexts?: string[]): Promise<ReportInput> {
  const names = await actorNames();
  const st = reduceEdits(ctx.edits);
  const obs = observationTexts ?? runObservations(ctx, out, cmp).map((o) => o.text);
  return {
    client: ctx.client.name,
    source: ctx.client.source_label || "SOC",
    label: periodLabel(ctx.period),
    short: shortPeriodLabel(ctx.period),
    period: ctx.period,
    periodTz: ctx.settings.periodTz,
    displayTz: ctx.settings.displayTz,
    A: out.agg,
    P: cmp?.P ?? null,
    P2: cmp?.P2 ?? null,
    prevLabel: cmp ? periodLabel(cmp.prev) : "Previous period",
    prevShort: cmp ? shortPeriodLabel(cmp.prev) : "Prev",
    p2Short: cmp ? shortPeriodLabel(cmp.prev2) : "Prev-2",
    cases: out.derived.map((d) => ({ ...d, ruleId: d.ruleId, match: d.match })),
    limits: ctx.threshold.limits,
    targets: ctx.threshold.targets,
    thresholdLabel: `${ctx.threshold.label} (v${ctx.threshold.version_no}, effective ${ctx.threshold.effective_from})`,
    rulesetLabel: `${ctx.ruleset.label} (v${ctx.ruleset.version_no})`,
    file: { name: ctx.run.source_file_name ?? "", sha256: ctx.run.source_file_hash ?? "", sheet: ctx.run.source_sheet ?? "", rows: ctx.run.row_count },
    runStatus: ctx.run.status,
    publishedAt: ctx.run.published_at,
    issues: out.issues.map((i) => ({ ...i, status: st.accepted.has(i.key) ? "accepted" : "open" })).concat(
      [...ctx.storedExceptions.values()]
        .filter((e) => e.status === "resolved")
        .map((e) => ({ key: e.key, type: e.type as never, blocking: e.severity === "blocking", rows: e.rows, title: (e.detail.title as string) ?? undefined, note: (e.detail.note as string) ?? undefined, caseId: (e.detail.caseId as string) ?? undefined, status: "resolved" })),
    ),
    edits: ctx.editRows.map((e) => ({ at: e.created_at, actor: (e.actor && names.get(e.actor)) || e.actor || "", kind: e.kind, caseId: e.case_id, rowNo: e.row_no, field: e.field ?? e.target_key, oldValue: e.old_value, newValue: e.new_value, reason: e.reason })),
    observations: obs,
    counts: { rows: out.counts.rows, included: out.counts.included, outOfPeriod: out.counts.outOfPeriod, dropped: out.counts.dropped, evaluable: out.counts.evaluable, informational: out.counts.informational },
  };
}

export const fileStem = (ctx: RunContext) => `SOC_Report_${ctx.client.name}_${ctx.period.cadence}_${ctx.period.start}_to_${ctx.period.end}`.replace(/[^A-Za-z0-9._-]+/g, "_");

/** Stores a generated file with the run (artifacts bucket) and records it. */
export async function storeArtifact(ctx: RunContext, kind: string, name: string, blob: Blob) {
  const path = `${ctx.client.id}/${ctx.run.id}/${Date.now()}_${name.replace(/[^A-Za-z0-9._-]+/g, "_")}`;
  const up = await supabase.storage.from("artifacts").upload(path, blob, { upsert: false, contentType: blob.type || "application/octet-stream" });
  if (up.error) throw new Error(up.error.message);
  must(await supabase.from("run_artifacts").insert({ run_id: ctx.run.id, kind, file_path: path, file_name: name, size_bytes: blob.size }));
}
