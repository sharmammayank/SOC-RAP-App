import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { useSession } from "@/lib/session";
import { supabase, must } from "@/lib/supabase";
import { latestThreshold, loadClientCases } from "@/lib/runService";
import type { Run } from "@/lib/db";
import { aggregate, type Aggregate } from "@/engine/aggregate";
import { compareCounts, compareSla, concentration, observations, priorityShift, DEFAULT_MATERIALITY } from "@/engine/analytics";
import { periodLabel, periodRange, previousPeriod, priorYearPeriod, shortPeriodLabel, type Period } from "@/engine/periods";
import { tzAbbrev } from "@/engine/tz";
import { METRICS } from "@/engine/types";
import { Button, Chip, CsvButton, Delta, Empty, ErrorBox, PageHeader, Panel, Select, Spinner, Textarea } from "@/components/ui";
import { EChart, axisStyle } from "@/components/charts";
import { SlaMatrix, KpiRow } from "@/features/run/ResultsView";
import { fmtDur, fmtInt, fmtPct } from "@/lib/format";

type Baseline = "previous" | "prior_year" | string; // or a run id

export default function ComparePage() {
  const { client } = useSession();
  const runs = useQuery({
    queryKey: ["published-runs", client?.id],
    enabled: !!client,
    queryFn: async () => must(await supabase.from("runs").select("id,period_start,period_end,cadence,status").eq("client_id", client!.id).eq("status", "published").order("period_start", { ascending: false })) as Pick<Run, "id" | "period_start" | "period_end" | "cadence" | "status">[],
  });
  const thr = useQuery({ queryKey: ["latest-threshold", client?.id], enabled: !!client, queryFn: () => latestThreshold(client!.id) });
  const [runId, setRunId] = useState<string>("");
  const [baseline, setBaseline] = useState<Baseline>("previous");
  useEffect(() => {
    if (runs.data?.length && !runs.data.some((r) => r.id === runId)) setRunId(runs.data[0].id);
  }, [runs.data, runId]);
  const cur = runs.data?.find((r) => r.id === runId);
  const period: Period | null = useMemo(() => (cur ? { cadence: cur.cadence, start: cur.period_start, end: cur.period_end } : null), [cur]);
  const base: Period | null = useMemo(() => {
    if (!period) return null;
    if (baseline === "previous") return previousPeriod(period);
    if (baseline === "prior_year") return priorYearPeriod(period);
    const r = runs.data?.find((x) => x.id === baseline);
    return r ? { cadence: r.cadence, start: r.period_start, end: r.period_end } : previousPeriod(period);
  }, [period, baseline, runs.data]);
  // Trend: the selected period and the five before it.
  const trendPeriods = useMemo(() => {
    if (!period) return [];
    const out = [period];
    for (let i = 0; i < 5; i++) out.unshift(previousPeriod(out[0]));
    return out;
  }, [period]);
  const tz = client?.period_tz ?? "UTC";
  const span = useMemo(() => {
    if (!period || !base) return null;
    const ws = [...trendPeriods, base].map((p) => periodRange(p, tz));
    return { from: Math.min(...ws.map((w) => w.from)), to: Math.max(...ws.map((w) => w.to)) };
  }, [period, base, trendPeriods, tz]);
  const data = useQuery({ queryKey: ["compare-cases", client?.id, span?.from, span?.to], enabled: !!span, queryFn: () => loadClientCases(client!.id, span!.from, span!.to), staleTime: 5 * 60_000 });
  const settings = { periodTz: tz, displayTz: client?.display_tz ?? "UTC" };
  const aggFor = useCallback(
    (p: Period): Aggregate | null => {
      if (!data.data || !thr.data) return null;
      const w = periodRange(p, tz);
      const cs = data.data.cases.filter((c) => c.ts.createdAt! >= w.from && c.ts.createdAt! < w.to);
      return aggregate(cs, { targets: thr.data.targets, from: w.from, to: w.to, settings });
    },
    [data.data, thr.data, tz], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const A = useMemo(() => (period ? aggFor(period) : null), [period, aggFor]);
  const P = useMemo(() => (base ? aggFor(base) : null), [base, aggFor]);
  const trend = useMemo(() => trendPeriods.map((p) => ({ p, a: aggFor(p) })), [trendPeriods, aggFor]);
  const curCases = useMemo(() => (period && data.data ? data.data.cases.filter((c) => { const w = periodRange(period, tz); return c.ts.createdAt! >= w.from && c.ts.createdAt! < w.to; }) : []), [period, data.data, tz]);
  const prevCases = useMemo(() => (base && data.data ? data.data.cases.filter((c) => { const w = periodRange(base, tz); return c.ts.createdAt! >= w.from && c.ts.createdAt! < w.to; }) : []), [base, data.data, tz]);
  const obs = useMemo(
    () =>
      A && period && base && client
        ? observations({ A, P: P && P.total ? P : null, cur: curCases, curLabel: periodLabel(period), prevLabel: periodLabel(base), source: client.source_label, displayTz: settings.displayTz, tzLabel: tzAbbrev(settings.displayTz), materiality: client.settings.materiality ?? DEFAULT_MATERIALITY })
        : [],
    [A, P, curCases, period, base, client], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [obsText, setObsText] = useState("");
  useEffect(() => setObsText(obs.map((o) => "• " + o.text).join("\n")), [obs]);
  const trendOpt = useCallback(
    (p: Parameters<typeof axisStyle>[0]) => ({
      grid: { left: 44, right: 44, top: 34, bottom: 28 },
      legend: { top: 0, textStyle: { color: p.ink2, fontSize: 11 } },
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: trend.map((t) => shortPeriodLabel(t.p)), ...axisStyle(p) },
      yAxis: [
        { type: "value", name: "Cases", nameTextStyle: { color: p.muted }, ...axisStyle(p) },
        { type: "value", name: "Compliance %", min: (v: { min: number }) => Math.max(0, Math.floor(v.min - 2)), max: 100, nameTextStyle: { color: p.muted }, ...axisStyle(p), splitLine: { show: false } },
      ],
      series: [
        { name: "Cases", type: "bar", data: trend.map((t) => t.a?.total ?? 0), itemStyle: { color: p.prev, borderRadius: [3, 3, 0, 0] } },
        ...METRICS.map((m, i) => ({ name: m.k, type: "line", yAxisIndex: 1, connectNulls: false, data: trend.map((t) => (t.a?.total ? t.a.overall[m.k].pct : null)), itemStyle: { color: [p.s1, p.s2, p.s3, p.s4][i] }, symbolSize: 6 })),
      ],
    }),
    [trend],
  );

  if (!client) return null;
  if (runs.isLoading || thr.isLoading) return <Spinner />;
  if (runs.error) return <ErrorBox error={runs.error} />;
  if (!runs.data?.length) return <Empty title="Nothing to compare yet">Publish at least one run. Comparisons use published runs only, so figures never shift while a period is still in review.</Empty>;

  const hasP = !!(P && P.total);
  const vol = A ? compareCounts(A.bucket, hasP ? P!.bucket : null) : [];
  const sla = A ? compareSla(A, hasP ? P : null) : [];
  const shift = A ? priorityShift(A, hasP ? P : null) : [];
  const cc = concentration(curCases, settings.displayTz),
    pc = concentration(prevCases, settings.displayTz);
  const curLbl = period ? shortPeriodLabel(period) : "",
    prevLbl = base ? shortPeriodLabel(base) : "";
  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        eyebrow="Comparison"
        title={period ? `${periodLabel(period)} vs ${base ? periodLabel(base) : "—"}` : "Comparison"}
        sub="Period-over-period volume, SLA attainment and elapsed-time movement, with observations generated only from these numbers."
        actions={
          <>
            <Select aria-label="Period" value={runId} onChange={(e) => setRunId(e.target.value)}>
              {runs.data.map((r) => (
                <option key={r.id} value={r.id}>
                  {periodLabel({ start: r.period_start, end: r.period_end, cadence: r.cadence })}
                </option>
              ))}
            </Select>
            <span className="text-[13px] text-muted">against</span>
            <Select aria-label="Baseline" value={baseline} onChange={(e) => setBaseline(e.target.value)}>
              <option value="previous">Previous {cur?.cadence === "weekly" ? "week" : cur?.cadence === "monthly" ? "month" : "period"}</option>
              <option value="prior_year">Same period last year</option>
              {runs.data
                .filter((r) => r.id !== runId)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {periodLabel({ start: r.period_start, end: r.period_end, cadence: r.cadence })}
                  </option>
                ))}
            </Select>
          </>
        }
      />
      {data.isLoading || !A ? (
        <Spinner label="Loading periods…" />
      ) : (
        <div className="flex flex-col gap-4">
          {!hasP && <Empty title={`No published data for ${base ? periodLabel(base) : "the baseline"}`}>Publish that period's run, or pick another baseline.</Empty>}
          <KpiRow A={A} P={hasP ? P : null} />
          <Panel title="Trend" sub="Case volume and case-weighted compliance, last six periods">
            <EChart option={trendOpt} height={280} ariaLabel="Six-period trend of volume and compliance" />
          </Panel>
          <div className="grid gap-4 xl:grid-cols-2">
            <Panel title="Volume by report bucket" actions={<CsvButton name="compare_buckets" rows={() => [["Bucket", curLbl, prevLbl, "Change", "Change %"], ...vol.map((r) => [r.key, r.cur, r.prev, r.delta, r.pct == null ? null : Math.round(r.pct * 10) / 10])]} />} pad={false}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Bucket</th>
                    <th className="r">{curLbl}</th>
                    <th className="r">{prevLbl}</th>
                    <th className="r">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {vol.map((r) => (
                    <tr key={r.key}>
                      <td>
                        {r.key} {r.status === "new" && <Chip tone="warn">New</Chip>} {r.status === "gone" && <Chip>Gone</Chip>}
                      </td>
                      <td className="r num">{fmtInt(r.cur)}</td>
                      <td className="r num">{r.prev == null ? "—" : fmtInt(r.prev)}</td>
                      <td className="r">{r.prev ? <Delta cur={r.cur} prev={r.prev} /> : "—"}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>
                      <b>Total</b>
                    </td>
                    <td className="r num font-semibold">{fmtInt(A.total)}</td>
                    <td className="r num">{hasP ? fmtInt(P!.total) : "—"}</td>
                    <td className="r">{hasP ? <Delta cur={A.total} prev={P!.total} /> : "—"}</td>
                  </tr>
                </tbody>
              </table>
            </Panel>
            <Panel title="Volume by priority" sub="Share-of-total shift in percentage points" pad={false}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Priority</th>
                    <th className="r">{curLbl}</th>
                    <th className="r">{prevLbl}</th>
                    <th className="r">Share</th>
                    <th className="r">Shift</th>
                  </tr>
                </thead>
                <tbody>
                  {shift.map((s) => (
                    <tr key={s.priority}>
                      <td>{s.priority}</td>
                      <td className="r num">{fmtInt(s.cur)}</td>
                      <td className="r num">{s.prev == null || !hasP ? "—" : fmtInt(s.prev)}</td>
                      <td className="r num">{s.share.toFixed(1)}%</td>
                      <td className="r num">{s.shiftPts == null || !hasP ? "—" : `${s.shiftPts >= 0 ? "+" : "−"}${Math.abs(s.shiftPts).toFixed(1)} pts`}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>Uncategorized rate</td>
                    <td className="r num">{A.total ? ((A.uncategorized / A.total) * 100).toFixed(1) : "0.0"}%</td>
                    <td className="r num">{hasP ? ((P!.uncategorized / P!.total) * 100).toFixed(1) + "%" : "—"}</td>
                    <td />
                    <td />
                  </tr>
                  <tr>
                    <td>Busiest 4-hour band ({tzAbbrev(settings.displayTz)})</td>
                    <td className="r num">
                      {String(cc.bandStart).padStart(2, "0")}:00 · {cc.bandShare.toFixed(0)}%
                    </td>
                    <td className="r num">{hasP ? `${String(pc.bandStart).padStart(2, "0")}:00 · ${pc.bandShare.toFixed(0)}%` : "—"}</td>
                    <td />
                    <td />
                  </tr>
                  <tr>
                    <td>Busiest weekday</td>
                    <td className="r">
                      {cc.topWeekday} · {cc.weekdayShare.toFixed(0)}%
                    </td>
                    <td className="r">{hasP ? `${pc.topWeekday} · ${pc.weekdayShare.toFixed(0)}%` : "—"}</td>
                    <td />
                    <td />
                  </tr>
                </tbody>
              </table>
            </Panel>
          </div>
          <SlaMatrix A={A} P={hasP ? P : null} limits={thr.data!.limits} title="SLA compliance (current targets)" fileStem={`compare_${curLbl}`} />
          <Panel
            title="SLA compliance and elapsed-time movement"
            actions={
              <CsvButton
                name="compare_sla"
                rows={() => [["Priority", "Metric", curLbl, prevLbl, "Delta pts", "Target", "Status", "Crossed", "Mean now (s)", "Mean before (s)", "P95 now (s)", "P95 before (s)"], ...sla.map((r) => [r.priority, r.metric, r.cur, r.prev, r.delta, r.target, r.status, r.crossed, r.meanCur, r.meanPrev, r.p95Cur, r.p95Prev])]}
              />
            }
            pad={false}
          >
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Priority · metric</th>
                    <th className="r">{curLbl}</th>
                    <th className="r">{prevLbl}</th>
                    <th className="r">Change</th>
                    <th>Target</th>
                    <th>Status</th>
                    <th className="r">Average</th>
                    <th className="r">P95</th>
                  </tr>
                </thead>
                <tbody>
                  {sla.map((r) => (
                    <tr key={r.priority + r.metric}>
                      <td>
                        {r.priority} · {r.metric}
                      </td>
                      <td className="r num">{fmtPct(r.cur)}</td>
                      <td className="r num">{fmtPct(r.prev)}</td>
                      <td className="r">{r.delta != null ? <Delta cur={r.cur} prev={r.prev} pts goodUp /> : "—"}</td>
                      <td className="num">{r.target}%</td>
                      <td>
                        {r.cur == null ? <Chip>No cases</Chip> : r.status === "ok" ? <Chip tone="good">Attained</Chip> : <Chip tone="bad">Breached</Chip>}{" "}
                        {r.crossed && <Chip tone={r.crossed === "recovered" ? "good" : "bad"}>{r.crossed === "recovered" ? "Recovered" : "Newly below"}</Chip>}
                      </td>
                      <td className="r num text-[12.5px]">
                        {fmtDur(r.meanCur)}
                        {r.meanPrev != null && <span className="text-muted"> (was {fmtDur(r.meanPrev)})</span>}
                      </td>
                      <td className="r num text-[12.5px]">
                        {fmtDur(r.p95Cur)}
                        {r.p95Prev != null && <span className="text-muted"> (was {fmtDur(r.p95Prev)})</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel
            title="Generated observations"
            sub="Ranked by materiality and traceable to the tables above. Edit freely before copying into the executive summary."
            actions={
              <Button size="sm" icon={<Copy className="size-3.5" />} onClick={() => navigator.clipboard.writeText(obsText).then(() => toast.success("Copied"))}>
                Copy
              </Button>
            }
          >
            <Textarea rows={Math.max(6, obs.length + 1)} value={obsText} onChange={(e) => setObsText(e.target.value)} className="w-full text-[13px]" aria-label="Observations" />
            <details className="mt-2 text-[12px]">
              <summary className="cursor-pointer text-accent">Show the values behind each observation</summary>
              <ul className="mt-2 space-y-1">
                {obs.map((o, i) => (
                  <li key={i}>
                    <Chip>{o.kind}</Chip> <span className="font-mono text-muted">{JSON.stringify(o.basis)}</span>
                  </li>
                ))}
              </ul>
            </details>
          </Panel>
        </div>
      )}
    </div>
  );
}
