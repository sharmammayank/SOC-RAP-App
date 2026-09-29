import { useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useRun } from "@/lib/useRun";
import { useSession } from "@/lib/session";
import { supabase, must } from "@/lib/supabase";
import { latestRuleset, latestThreshold } from "@/lib/runService";
import { loadComparison } from "@/lib/report";
import type { MetricSnapshot } from "@/lib/db";
import { periodLabel } from "@/engine/periods";
import { tzAbbrev } from "@/engine/tz";
import { METRIC_KEYS, PRIORITIES } from "@/engine/types";
import { Button, Callout, Chip, Dialog, ErrorBox, PageHeader, Panel, Spinner, Stat, cx } from "@/components/ui";
import { RunStatusChip, StepRail } from "@/components/RunBits";
import { SlaMatrix, KpiRow, Breakdowns, WorstCases } from "@/features/run/ResultsView";
import { ReviewQueue } from "@/features/run/ReviewQueue";
import { CasesView } from "@/features/run/CasesView";
import { PublishView } from "@/features/run/PublishView";
import { ExportsPanel } from "@/features/run/ExportsPanel";
import { ActivityView } from "@/features/run/ActivityView";
import { fmtInt, fmtPct } from "@/lib/format";

type Tab = "summary" | "review" | "results" | "cases" | "publish" | "exports" | "activity";

export default function RunPage() {
  const { id } = useParams();
  const [sp, setSp] = useSearchParams();
  const ws = useRun(id, { autoClassify: sp.get("auto") === "1" });
  const { can } = useSession();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { ctx, out } = ws;
  const locked = ctx ? ctx.run.status === "published" || ctx.run.status === "superseded" : false;
  const defaultTab: Tab = locked ? "results" : "summary";
  const requested = sp.get("tab") as Tab | null;
  // Published runs have no Summary or Publish step; fall back to Results.
  const tab: Tab = requested && !(locked && (requested === "summary" || requested === "publish")) ? requested : defaultTab;
  const setTab = (t: Tab) => {
    const n = new URLSearchParams(sp);
    n.set("tab", t);
    n.delete("auto");
    setSp(n, { replace: true });
  };
  const [delOpen, setDelOpen] = useState(false);

  const cmp = useQuery({ queryKey: ["cmp", ctx?.run.id, ctx?.run.status], enabled: !!ctx && ctx.run.status !== "draft", queryFn: () => loadComparison(ctx!), staleTime: 5 * 60_000 });
  const latest = useQuery({
    queryKey: ["latest-versions", ctx?.client.id],
    enabled: !!ctx && !locked,
    queryFn: async () => ({ t: await latestThreshold(ctx!.client.id), r: await latestRuleset(ctx!.client.id) }),
  });
  const snap = useQuery({
    queryKey: ["snapshot", ctx?.run.id],
    enabled: !!ctx && locked,
    queryFn: async () => must(await supabase.from("metric_snapshots").select("*").eq("run_id", ctx!.run.id)) as MetricSnapshot[],
  });
  // AT-12: a published run recomputed from its raw rows, edits and recorded versions must match its snapshot.
  const reproducible = useMemo(() => {
    if (!snap.data || !out) return null;
    const bad = snap.data.filter((s) => {
      const c = s.priority === "All" ? out.agg.overall[s.metric as "TTA"] : out.agg.sla[s.priority as "High"]?.[s.metric as "TTA"];
      return !c || c.met !== s.met || c.notMet !== s.not_met || (c.pct ?? null) !== (s.compliance_pct == null ? null : Number(s.compliance_pct));
    });
    return bad.length === 0;
  }, [snap.data, out]);

  if (ws.loading && !ctx) return <Spinner label={ws.loading} />;
  if (ws.error) return <ErrorBox error={ws.error} onRetry={ws.reload} />;
  if (!ctx) return null;
  const canEdit = ws.editable && can("review", ctx.client.id);
  const isOwner = can("own", ctx.client.id);

  if (ctx.run.status === "draft") {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader eyebrow={ctx.client.name} title={periodLabel(ctx.period)} />
        <Callout tone="warn" title="Staging didn't finish.">
          The file was stored but its rows weren't all staged. Delete this draft and upload the file again.
        </Callout>
        {isOwner && (
          <div className="mt-4">
            <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setDelOpen(true)}>
              Delete draft
            </Button>
          </div>
        )}
        <DeleteDialog open={delOpen} setOpen={setDelOpen} onDelete={del} />
      </div>
    );
  }
  async function del() {
    if (!ctx) return;
    try {
      if (ctx.run.source_file_path) await supabase.storage.from("uploads").remove([ctx.run.source_file_path]);
      must(await supabase.from("runs").delete().eq("id", ctx.run.id));
      qc.invalidateQueries({ queryKey: ["run-overview"] });
      toast.success("Run deleted");
      nav("/");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }
  if (!out) return <Spinner label={ws.loading ?? "Calculating…"} />;

  const step = tab === "summary" ? 2 : tab === "publish" ? 4 : 3;
  const done = locked ? 5 : ctx.run.status === "review" ? (out.counts.blockingOpen ? 3 : 4) : 2;
  const newer = latest.data && (latest.data.t.id !== ctx.threshold.id || latest.data.r.id !== ctx.ruleset.id);
  const tabs: [Tab, string, React.ReactNode?][] = locked
    ? [
        ["results", "Results"],
        ["cases", "Cases"],
        ["review", "Exceptions"],
        ["exports", "Exports"],
        ["activity", "Activity"],
      ]
    : [
        ["summary", "Summary"],
        ["review", "Review", out.counts.blockingOpen ? <Chip tone="bad">{out.counts.blockingOpen}</Chip> : out.counts.nonBlockingOpen ? <Chip tone="warn">{out.counts.nonBlockingOpen}</Chip> : null],
        ["results", "Results"],
        ["cases", "Cases"],
        ["publish", "Publish"],
        ["exports", "Exports"],
        ["activity", "Activity"],
      ];
  const uncatWarn = out.counts.uncategorizedPct > ctx.settings.uncategorizedWarnPct;

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        eyebrow={
          <span className="flex items-center gap-2">
            {ctx.client.name} · {ctx.period.cadence} run <RunStatusChip status={ctx.run.status} />
          </span>
        }
        title={periodLabel(ctx.period)}
        sub={`${ctx.run.source_file_name} · ${fmtInt(ctx.run.row_count)} rows · periods counted in ${ctx.settings.periodTz} (${tzAbbrev(ctx.settings.periodTz)}), hours shown in ${tzAbbrev(ctx.settings.displayTz)}`}
        actions={
          <>
            {ws.busy && <Spinner label={ws.busy} />}
            {isOwner && !locked && (
              <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setDelOpen(true)}>
                Delete run
              </Button>
            )}
          </>
        }
      />
      {!locked && <StepRail current={step} done={done} onPick={(i) => setTab(i === 2 ? "summary" : i === 3 ? "review" : i === 4 ? "publish" : tab)} />}

      {!locked && (
        <div className={cx("mb-4 grid gap-3 rounded-lg border px-4 py-3 text-[13px] md:grid-cols-[minmax(0,1fr)_auto]", out.counts.blockingOpen ? "border-bad/30 bg-bad-bg" : "border-good/30 bg-good-bg")} role="status" aria-live="polite">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <b className={out.counts.blockingOpen ? "text-bad" : "text-good"}>{out.counts.blockingOpen ? `${out.counts.blockingOpen} blocking` : "Ready to publish"}</b>
            <span className="num">{fmtInt(out.counts.rows)} records</span>
            <span className="num">{fmtInt(out.counts.included)} in period</span>
            <span className="num">{fmtInt(out.counts.evaluable)} SLA-evaluable</span>
            <span className="num">{fmtInt(out.counts.informational)} Informational excluded</span>
            <span className="num">{fmtInt(out.counts.nonBlockingOpen)} non-blocking open</span>
            <span className={cx("num", uncatWarn && "font-semibold text-warn")}>
              Uncategorized {out.counts.uncategorizedPct.toFixed(1)}%{uncatWarn ? ` (above the ${ctx.settings.uncategorizedWarnPct}% warning level)` : ""}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
            <span>
              SLA <b>{ctx.threshold.label}</b> v{ctx.threshold.version_no} · Rules <b>{ctx.ruleset.label}</b> v{ctx.ruleset.version_no}
            </span>
          </div>
        </div>
      )}
      {!locked && newer && isOwner && (
        <div className="mb-4">
          <Callout
            tone="info"
            title="Newer configuration available."
            action={
              <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={ws.adoptLatest} disabled={!!ws.busy}>
                Recalculate with SLA v{latest.data!.t.version_no} and rules v{latest.data!.r.version_no}
              </Button>
            }
          >
            This run uses SLA v{ctx.threshold.version_no} and rules v{ctx.ruleset.version_no}. Switching is recorded in the run history; review decisions are kept.
          </Callout>
        </div>
      )}
      {locked && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
          <ShieldCheck className="size-4 text-good" />
          Published {ctx.run.published_at ? new Date(ctx.run.published_at).toLocaleString() : ""} with SLA <b>{ctx.threshold.label}</b> v{ctx.threshold.version_no} and rules <b>{ctx.ruleset.label}</b> v{ctx.ruleset.version_no}. The run is locked.
          {reproducible === true && (
            <Chip tone="good">
              <CheckCircle2 className="size-3" /> Recalculation matches the published snapshot
            </Chip>
          )}
          {reproducible === false && <Chip tone="bad">Recalculation differs from the published snapshot</Chip>}
          {ctx.run.status === "superseded" && <Chip tone="warn">Superseded by a later run for this period</Chip>}
        </div>
      )}

      <div role="tablist" aria-label="Run sections" className="mb-4 flex flex-wrap gap-1 border-b border-line">
        {tabs.map(([k, l, badge]) => (
          <button
            key={k}
            role="tab"
            type="button"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cx("-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium", tab === k ? "border-accent text-accent" : "border-transparent text-ink-2 hover:text-ink")}
          >
            {l}
            {badge}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="flex flex-col gap-4">
        {tab === "summary" && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <Stat label="Total records" value={fmtInt(out.counts.rows)} />
              <Stat label="Categorized" value={fmtInt(out.counts.included - out.counts.uncategorized)} note={`${out.agg.total ? (((out.counts.included - out.counts.uncategorized) / out.agg.total) * 100).toFixed(1) : 0}% by rules`} />
              <Stat label="Uncategorized" value={fmtInt(out.counts.uncategorized)} tone={uncatWarn ? "warn" : undefined} />
              <Stat label="Blocking" value={fmtInt(out.counts.blockingOpen)} tone={out.counts.blockingOpen ? "bad" : "good"} />
              <Stat label="Non-blocking" value={fmtInt(out.counts.nonBlockingOpen)} tone={out.counts.nonBlockingOpen ? "warn" : undefined} />
              <Stat label="Informational excluded" value={fmtInt(out.counts.informational)} />
            </div>
            {ws.ctx && out.rejectedRules.length > 0 && (
              <Callout tone="warn" title="Some rules were skipped.">
                {out.rejectedRules.map((r) => `${r.rule_id}: ${r.error}`).join(" · ")}
              </Callout>
            )}
            <Panel title="Headline compliance" sub="Case-weighted across priorities. Details are on the Results tab.">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {METRIC_KEYS.map((m) => (
                  <div key={m} className="rounded-md bg-surface-2 px-3 py-2">
                    <div className="eyebrow">{m}</div>
                    <div className="num text-[20px] font-semibold">{fmtPct(out.agg.overall[m].pct)}</div>
                    <div className="text-[12px] text-muted">
                      {PRIORITIES.filter((p) => out.agg.sla[p][m].status === "bad").length
                        ? `Below target: ${PRIORITIES.filter((p) => out.agg.sla[p][m].status === "bad").join(", ")}`
                        : "All priority targets met"}
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => setTab("review")}>
                {out.counts.blockingOpen || out.counts.nonBlockingOpen ? "Go to review" : "Review (nothing open)"}
              </Button>
              <Button onClick={() => setTab("results")}>See results</Button>
            </div>
          </>
        )}
        {tab === "review" && <ReviewQueue ws={ws} canEdit={canEdit} canPromote={isOwner} />}
        {tab === "results" && (
          <>
            <KpiRow A={out.agg} P={cmp.data?.P} />
            <SlaMatrix A={out.agg} P={cmp.data?.P} limits={ctx.threshold.limits} fileStem={`sla_${ctx.period.start}`} />
            <Breakdowns A={out.agg} P={cmp.data?.P} curLabel={periodLabel(ctx.period)} prevLabel={cmp.data ? periodLabel(cmp.data.prev) : undefined} />
            <WorstCases A={out.agg} />
          </>
        )}
        {tab === "cases" && <CasesView ws={ws} canEdit={canEdit} />}
        {tab === "publish" && <PublishView ws={ws} cmp={cmp.data} canPublish={isOwner} />}
        {tab === "exports" && <ExportsPanel ws={ws} cmp={cmp.data} canStore={can("review", ctx.client.id)} />}
        {tab === "activity" && <ActivityView ws={ws} />}
      </div>
      <DeleteDialog open={delOpen} setOpen={setDelOpen} onDelete={del} />
    </div>
  );
}

function DeleteDialog({ open, setOpen, onDelete }: { open: boolean; setOpen: (o: boolean) => void; onDelete: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Delete this run?"
      description="The uploaded file, staged rows, results and review decisions for this unpublished run are removed. Published runs can only be purged by an administrator."
      footer={
        <>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              await onDelete();
              setBusy(false);
              setOpen(false);
            }}
          >
            Delete run
          </Button>
        </>
      }
    />
  );
}
