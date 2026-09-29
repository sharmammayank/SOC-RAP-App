import { useCallback } from "react";
import type { Aggregate, SlaCell } from "@/engine/aggregate";
import { ALL_PRIORITIES, METRICS, PRIORITIES, type Limits, type Metric, type SlaPriority } from "@/engine/types";
import { fmtLimit } from "@/engine/defaults";
import { fmtDur, fmtInt, fmtPct, fmtSecs } from "@/lib/format";
import { Chip, Delta, Panel, PrioDot, Stat, Tip, CsvButton, cx } from "@/components/ui";
import { EChart, axisStyle } from "@/components/charts";

/** Priority × metric compliance matrix with targets, variance and the prior period's value (spec §5.3). */
export function SlaMatrix({ A, P, limits, title = "SLA compliance by priority", fileStem }: { A: Aggregate; P?: Aggregate | null; limits: Limits; title?: string; fileStem: string }) {
  const cell = (c: SlaCell, pc: SlaCell | null, p: SlaPriority, m: Metric) => (
    <Tip
      key={m}
      content={
        <div className="space-y-0.5">
          <div className="font-semibold">
            {p} · {m}
          </div>
          <div>
            Met {fmtInt(c.met)} · Not met {fmtInt(c.notMet)} · Pending {fmtInt(c.pending)} · N/A {fmtInt(c.na)} · Data error {fmtInt(c.err)}
          </div>
          <div>
            Mean {fmtDur(c.mean)} · Median {fmtDur(c.median)} · P95 {fmtDur(c.p95)}
            {c.zero ? ` (excludes ${fmtInt(c.zero)} counted as 0 s)` : ""}
          </div>
          <div>Previous: {pc?.pct != null ? fmtPct(pc.pct) : "no data"}</div>
        </div>
      }
    >
      <td tabIndex={0} className="align-top">
        <div className="flex flex-col gap-0.5">
          <span className="num text-[19px] font-semibold">{c.pct == null ? "—" : fmtPct(c.pct)}</span>
          <span className="num text-[11.5px] text-muted">
            n={fmtInt(c.n)}
            {c.zero ? ` · ${fmtInt(c.zero)} at 0 s` : ""}
            {c.pending ? ` · ${c.pending} pending` : ""} · limit {fmtLimit(limits[p][m])}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            {c.pct == null ? (
              <Chip>No evaluable cases</Chip>
            ) : c.status === "ok" ? (
              <Chip tone="good">✓ Meets {c.target}%</Chip>
            ) : (
              <Chip tone="bad">✗ Below {c.target}% ({c.variance?.toFixed(2)} pts)</Chip>
            )}
            {P && pc?.pct != null && c.pct != null && <Delta cur={c.pct} prev={pc.pct} pts goodUp />}
          </span>
        </div>
      </td>
    </Tip>
  );
  const rows = () => {
    const out: (string | number | null)[][] = [["Priority", "Metric", "Limit (s)", "Target %", "Met", "Not met", "Pending", "N/A", "Data error", "Compliance %", "Status", "Mean s", "Median s", "P95 s", "Previous %"]];
    for (const p of PRIORITIES)
      for (const m of METRICS) {
        const c = A.sla[p][m.k];
        out.push([p, m.k, limits[p][m.k].seconds, c.target, c.met, c.notMet, c.pending, c.na, c.err, c.pct, c.status === "ok" ? "Attained" : c.status === "bad" ? "Breached" : "No evaluable cases", c.mean, c.median, c.p95, P?.sla[p][m.k].pct ?? null]);
      }
    return out;
  };
  return (
    <Panel title={title} sub="Compliance = Met ÷ (Met + Not met). Pending, N/A and data errors are excluded. Hover a cell for mean, median and P95." actions={<CsvButton rows={rows} name={fileStem + "_sla"} />} pad={false}>
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>Priority</th>
              {METRICS.map((m) => (
                <th key={m.k}>
                  {m.k} · {m.short}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PRIORITIES.map((p) => (
              <tr key={p}>
                <td>
                  <PrioDot p={p} />
                  <b>{p}</b>
                  <div className="num text-[12px] text-muted">{fmtInt(A.byPrio[p])} cases</div>
                </td>
                {METRICS.map((m) => cell(A.sla[p][m.k], P?.sla[p][m.k] ?? null, p, m.k))}
              </tr>
            ))}
            <tr>
              <td>
                <b>All priorities</b>
                <div className="text-[12px] text-muted">case-weighted</div>
              </td>
              {METRICS.map((m) => {
                const c = A.overall[m.k];
                return (
                  <td key={m.k}>
                    <span className="num text-[16px] font-semibold">{fmtPct(c.pct)}</span>
                    <div className="num text-[11.5px] text-muted">
                      n={fmtInt(c.n)} · median {fmtDur(c.median)}
                    </div>
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function KpiRow({ A, P }: { A: Aggregate; P?: Aggregate | null }) {
  const tp = A.total ? (A.tp / A.total) * 100 : 0,
    ptp = P && P.total ? (P.tp / P.total) * 100 : null;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <Stat label="Cases" value={fmtInt(A.total)} delta={P ? <Delta cur={A.total} prev={P.total || null} /> : undefined} />
      <Stat label="SLA-evaluable" value={fmtInt(A.evaluable)} note={`${fmtInt(A.byPrio.Informational)} Informational excluded`} />
      <Stat label="Auto-closed" value={fmtInt(A.auto)} delta={P ? <Delta cur={A.auto} prev={P.total ? P.auto : null} goodUp /> : undefined} />
      <Stat label="True positive rate" value={fmtPct(tp, 1)} delta={ptp != null ? <Delta cur={tp} prev={ptp} pts /> : undefined} note={`${fmtInt(A.tp)} cases`} />
      <Stat label="Open" value={fmtInt(A.open)} note="Pending until past the TTR limit" />
      <Stat label="Uncategorized" value={fmtInt(A.uncategorized)} tone={A.uncategorized ? "warn" : undefined} note={A.total ? `${((A.uncategorized / A.total) * 100).toFixed(1)}% of cases` : ""} />
    </div>
  );
}

export function Breakdowns({ A, P, curLabel, prevLabel }: { A: Aggregate; P?: Aggregate | null; curLabel: string; prevLabel?: string }) {
  const sev = useCallback(
    (p: Parameters<typeof axisStyle>[0]) => ({
      grid: { left: 44, right: 12, top: 28, bottom: 28 },
      legend: { top: 0, right: 0, textStyle: { color: p.ink2, fontSize: 11 } },
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: [...ALL_PRIORITIES], ...axisStyle(p) },
      yAxis: { type: "value", ...axisStyle(p) },
      series: [
        { name: curLabel, type: "bar", data: ALL_PRIORITIES.map((x) => A.byPrio[x]), itemStyle: { color: p.s1, borderRadius: [3, 3, 0, 0] }, label: { show: true, position: "top", fontSize: 10, color: p.ink2 } },
        ...(P && P.total ? [{ name: prevLabel, type: "bar", data: ALL_PRIORITIES.map((x) => P.byPrio[x]), itemStyle: { color: p.prev, borderRadius: [3, 3, 0, 0] } }] : []),
      ],
    }),
    [A, P, curLabel, prevLabel],
  );
  const items = Object.entries(A.bucket).sort((a, b) => a[1] - b[1]);
  const bkt = useCallback(
    (p: Parameters<typeof axisStyle>[0]) => ({
      grid: { left: 120, right: 40, top: 8, bottom: 20 },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      legend: P && P.total ? { bottom: 0, textStyle: { color: p.ink2, fontSize: 11 } } : undefined,
      xAxis: { type: "value", ...axisStyle(p) },
      yAxis: { type: "category", data: items.map((x) => x[0]), ...axisStyle(p), axisLabel: { color: p.ink2, fontSize: 11.5 } },
      series: [
        { name: curLabel, type: "bar", data: items.map((x) => x[1]), itemStyle: { color: p.s1, borderRadius: [0, 3, 3, 0] }, label: { show: true, position: "right", fontSize: 10, color: p.ink2 } },
        ...(P && P.total ? [{ name: prevLabel, type: "bar", data: items.map((x) => P.bucket[x[0]] || 0), itemStyle: { color: p.prev }, barWidth: 4 }] : []),
      ],
    }),
    [P, items, curLabel, prevLabel],
  );
  const keys = A.daily.map((d) => d[0]);
  const DS: [string, keyof ReturnType<typeof import("@/components/charts").palette>][] = [
    ["True Positive", "s1"],
    ["Benign Positive", "s2"],
    ["False Positive", "s3"],
    ["Waiting Client", "s4"],
    ["Pending", "s5"],
  ];
  const trend = useCallback(
    (p: Parameters<typeof axisStyle>[0]) => ({
      grid: { left: 44, right: 12, top: 30, bottom: 30 },
      legend: { top: 0, textStyle: { color: p.ink2, fontSize: 11 } },
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: keys.map((k) => (k.length === 10 ? k.slice(8) + "/" + k.slice(5, 7) : k)), ...axisStyle(p) },
      yAxis: { type: "value", ...axisStyle(p) },
      series: [
        ...DS.filter(([n]) => A.daily.some((d) => d[1][n])).map(([n, c]) => ({ name: n, type: "bar", stack: "d", data: A.daily.map((d) => d[1][n] || 0), itemStyle: { color: p[c] } })),
        {
          name: "Other",
          type: "bar",
          stack: "d",
          data: A.daily.map((d) => Object.entries(d[1]).filter(([k]) => !DS.some(([n]) => n === k)).reduce((a, [, v]) => a + v, 0)),
          itemStyle: { color: p.prev },
        },
      ],
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [A],
  );
  return (
    <>
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Cases by severity" sub={P && P.total ? `${curLabel} vs ${prevLabel}` : curLabel}>
          <EChart option={sev} ariaLabel="Cases by severity" />
        </Panel>
        <Panel title="Cases by report bucket" sub={P && P.total ? "Thin bar = previous period" : undefined}>
          <EChart option={bkt} height={Math.max(220, items.length * 30 + 40)} ariaLabel="Cases by report bucket" />
        </Panel>
      </div>
      <Panel title={A.to - A.from <= 2 * 86400000 ? "Disposition by hour" : "Daily disposition trend"}>
        <EChart option={trend} height={280} ariaLabel="Disposition trend" />
      </Panel>
    </>
  );
}

/** The five worst breaching cases per metric (spec §5.3 supporting statistics). */
export function WorstCases({ A }: { A: Aggregate }) {
  const any = METRICS.some((m) => A.overall[m.k].worst.length);
  if (!any) return null;
  return (
    <Panel title="Worst breaching cases" sub="Largest elapsed times among NOT MET cases, per metric">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {METRICS.map((m) => (
          <div key={m.k}>
            <div className="eyebrow mb-1">
              {m.k} · {m.short}
            </div>
            {A.overall[m.k].worst.length ? (
              <ol className="space-y-1 text-[12.5px]">
                {A.overall[m.k].worst.map((w, i) => (
                  <li key={i} className={cx("flex justify-between gap-2 border-b border-line pb-1")}>
                    <span className="min-w-0 truncate" title={w.title}>
                      <span className="font-mono text-[11.5px] text-muted">{w.caseId}</span> {w.title}
                    </span>
                    <span className="num shrink-0 font-medium text-bad">{fmtSecs(w.el)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[12.5px] text-muted">No breaches.</p>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}
