import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/lib/session";
import { supabase, must } from "@/lib/supabase";
import { loadClientCases } from "@/lib/runService";
import type { Run } from "@/lib/db";
import { HEAT_KINDS, cellCases, heatmap, type Granularity, type HeatKind, concentration } from "@/engine/analytics";
import { ALL_PRIORITIES, METRICS, type Metric } from "@/engine/types";
import { addDays, fmtInTz, tzAbbrev, ymdOf, ymdToUtc } from "@/engine/tz";
import { mondayOf, monthBounds, periodLabel } from "@/engine/periods";
import { Heatmap } from "@/components/Heatmap";
import { Button, Dialog, Empty, ErrorBox, Input, Label, PageHeader, Panel, Segmented, Select, Spinner, StatusChip, Stat } from "@/components/ui";
import { fmtInt } from "@/lib/format";
import type { AggCase } from "@/engine/aggregate";

type Preset = "latest" | "this_week" | "last_week" | "this_month" | "last_month" | "last_90" | "custom";

export default function AnalyticsPage() {
  const { client } = useSession();
  const tz = client?.period_tz ?? "UTC",
    dtz = client?.display_tz ?? "UTC";
  const latest = useQuery({
    queryKey: ["latest-published", client?.id],
    enabled: !!client,
    queryFn: async () => must(await supabase.from("runs").select("id,period_start,period_end,cadence").eq("client_id", client!.id).eq("status", "published").order("period_start", { ascending: false }).limit(1).maybeSingle()) as Pick<Run, "id" | "period_start" | "period_end" | "cadence"> | null,
  });
  const [preset, setPreset] = useState<Preset>("latest");
  const [custom, setCustom] = useState({ start: "", end: "" });
  const [kind, setKind] = useState<HeatKind>("volumeByHour");
  const [gran, setGran] = useState<Granularity>("day");
  const [topN, setTopN] = useState(15);
  const [nums, setNums] = useState(true);
  const [rowsBy, setRowsBy] = useState<"weekday" | "date">("weekday");
  const [metric, setMetric] = useState<Metric | "ANY">("ANY");
  const [breachMode, setBreachMode] = useState<"count" | "pct">("pct");
  const [f, setF] = useState({ category: "", priority: "", disposition: "", status: "" });
  const [drill, setDrill] = useState<{ title: string; cases: AggCase[] } | null>(null);

  const today = ymdOf(Date.now(), tz);
  const win = useMemo(() => {
    const p = (s: string, e: string) => ({ start: s, end: e });
    switch (preset) {
      case "latest":
        return latest.data ? p(latest.data.period_start, latest.data.period_end) : null;
      case "this_week": {
        const s = mondayOf(today);
        return p(s, addDays(s, 6));
      }
      case "last_week": {
        const s = addDays(mondayOf(today), -7);
        return p(s, addDays(s, 6));
      }
      case "this_month": {
        const [s, e] = monthBounds(today.slice(0, 7));
        return p(s, e);
      }
      case "last_month": {
        const [y, m] = today.split("-").map(Number);
        const [s, e] = monthBounds(new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7));
        return p(s, e);
      }
      case "last_90":
        return p(addDays(today, -89), today);
      case "custom":
        return custom.start && custom.end && custom.end >= custom.start ? p(custom.start, custom.end) : null;
    }
  }, [preset, latest.data, custom, today]);
  useEffect(() => {
    if (win) {
      const days = (Date.parse(win.end) - Date.parse(win.start)) / 86400000 + 1;
      setGran((g) => (g === "hour" ? g : days > 120 ? "month" : days > 35 ? "week" : "day"));
    }
  }, [win]);
  const range = useMemo(() => (win ? { from: ymdToUtc(win.start, tz), to: ymdToUtc(addDays(win.end, 1), tz) } : null), [win, tz]);
  const cmpRange = useMemo(() => (range ? { from: range.from - (range.to - range.from), to: range.from } : null), [range]);

  const data = useQuery({
    queryKey: ["analytics-cases", client?.id, cmpRange?.from, range?.to],
    enabled: !!client && !!range,
    queryFn: () => loadClientCases(client!.id, cmpRange!.from, range!.to),
    staleTime: 5 * 60_000,
  });
  const filtered = useMemo(() => {
    const all = data.data?.cases ?? [];
    return all.filter(
      (c) =>
        (!f.category || c.category === f.category) &&
        (!f.priority || c.priority === f.priority) &&
        (!f.disposition || (c.disposition || "Unknown") === f.disposition) &&
        (!f.status || METRICS.some((m) => c.ev[m.k].s === f.status)),
    );
  }, [data.data, f]);
  const cur = useMemo(() => (range ? filtered.filter((c) => c.ts.createdAt! >= range.from && c.ts.createdAt! < range.to) : []), [filtered, range]);
  const opts = { kind, granularity: kind === "volumeByHour" || kind === "detectionByHour" ? ("hour" as const) : gran, displayTz: dtz, periodTz: tz, topN, metric, breachMode, rowsBy };
  const grid = useMemo(() => (range ? heatmap(filtered, opts, range) : null), [filtered, range, kind, gran, topN, metric, breachMode, rowsBy, dtz, tz]); // eslint-disable-line react-hooks/exhaustive-deps
  const cgrid = useMemo(() => (cmpRange && (kind === "volumeByHour" || kind === "categoryByPriority" || kind === "detectionByHour" || kind === "dispositionByDetection") ? heatmap(filtered, opts, cmpRange) : null), [filtered, cmpRange?.from, kind, topN, rowsBy]); // eslint-disable-line react-hooks/exhaustive-deps
  const cats = useMemo(() => [...new Set((data.data?.cases ?? []).map((c) => c.category))].sort(), [data.data]);
  const disps = useMemo(() => [...new Set((data.data?.cases ?? []).map((c) => c.disposition || "Unknown"))].sort(), [data.data]);
  const conc = useMemo(() => concentration(cur, dtz), [cur, dtz]);

  if (!client) return null;
  const colLabel = (c: string) => (kind === "volumeByHour" || kind === "detectionByHour" ? c : c.length === 10 ? `${c.slice(8)}/${c.slice(5, 7)}` : c);
  const sortedRows = grid;
  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader eyebrow="Analytics" title={`Heatmaps · ${client.name}`} sub={`Pick a window and granularity; the grid re-renders from calculated results without re-running anything. Hours are in ${dtz} (${tzAbbrev(dtz)}). Built from published runs.`} />
      <Panel className="mb-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <div className="eyebrow mb-1">Window</div>
            <Select aria-label="Time window" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
              <option value="latest">Latest published period{latest.data ? ` (${periodLabel({ start: latest.data.period_start, end: latest.data.period_end, cadence: latest.data.cadence })})` : ""}</option>
              <option value="this_week">This week</option>
              <option value="last_week">Last week</option>
              <option value="this_month">This month</option>
              <option value="last_month">Last month</option>
              <option value="last_90">Last 90 days</option>
              <option value="custom">Custom range</option>
            </Select>
          </div>
          {preset === "custom" && (
            <div className="flex items-end gap-2">
              <div>
                <Label htmlFor="c-from">From</Label>
                <Input id="c-from" type="date" value={custom.start} onChange={(e) => setCustom({ ...custom, start: e.target.value })} className="mt-1" />
              </div>
              <div>
                <Label htmlFor="c-to">To</Label>
                <Input id="c-to" type="date" value={custom.end} onChange={(e) => setCustom({ ...custom, end: e.target.value })} className="mt-1" />
              </div>
            </div>
          )}
          <div>
            <div className="eyebrow mb-1">Heatmap</div>
            <Select aria-label="Heatmap" value={kind} onChange={(e) => setKind(e.target.value as HeatKind)}>
              {HEAT_KINDS.map((k) => (
                <option key={k.k} value={k.k}>
                  {k.label}
                </option>
              ))}
            </Select>
          </div>
          {(kind === "categoryByTime" || kind === "breachDensity") && (
            <div>
              <div className="eyebrow mb-1">Granularity</div>
              <Segmented label="Granularity" size="sm" value={gran} onChange={setGran} options={(["hour", "day", "week", "month"] as Granularity[]).map((g) => ({ v: g, label: g[0].toUpperCase() + g.slice(1) }))} />
            </div>
          )}
          {kind === "volumeByHour" && (
            <div>
              <div className="eyebrow mb-1">Rows</div>
              <Segmented label="Rows" size="sm" value={rowsBy} onChange={setRowsBy} options={[{ v: "weekday", label: "Weekday" }, { v: "date", label: "Date" }]} />
            </div>
          )}
          {kind === "breachDensity" && (
            <>
              <div>
                <div className="eyebrow mb-1">Metric</div>
                <Select aria-label="Metric" value={metric} onChange={(e) => setMetric(e.target.value as Metric | "ANY")}>
                  <option value="ANY">Any metric</option>
                  {METRICS.map((m) => (
                    <option key={m.k} value={m.k}>
                      {m.k}
                    </option>
                  ))}
                </Select>
              </div>
              <Segmented label="Value" size="sm" value={breachMode} onChange={setBreachMode} options={[{ v: "pct", label: "Breach %" }, { v: "count", label: "NOT MET count" }]} />
            </>
          )}
          {["detectionByHour", "categoryByTime", "categoryByPriority", "dispositionByDetection"].includes(kind) && (
            <div>
              <div className="eyebrow mb-1">Rows</div>
              <Select aria-label="Top rows" value={topN} onChange={(e) => setTopN(Number(e.target.value))}>
                {[10, 15, 20, 30, 50].map((n) => (
                  <option key={n} value={n}>
                    Top {n}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <label className="flex h-9 items-center gap-1.5 text-[13px]">
            <input type="checkbox" checked={nums} onChange={(e) => setNums(e.target.checked)} /> Show numbers
          </label>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-3">
          <span className="eyebrow">Filters</span>
          <Select aria-label="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            <option value="">All categories</option>
            {cats.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
          <Select aria-label="Priority" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
            <option value="">All priorities</option>
            {ALL_PRIORITIES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </Select>
          <Select aria-label="Disposition" value={f.disposition} onChange={(e) => setF({ ...f, disposition: e.target.value })}>
            <option value="">All dispositions</option>
            {disps.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </Select>
          <Select aria-label="SLA status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="">Any SLA status</option>
            <option value="NOT_MET">Any metric not met</option>
            <option value="MET">Any metric met</option>
            <option value="PENDING">Any metric pending</option>
          </Select>
          {(f.category || f.priority || f.disposition || f.status) && (
            <Button size="sm" variant="ghost" onClick={() => setF({ category: "", priority: "", disposition: "", status: "" })}>
              Clear filters
            </Button>
          )}
        </div>
      </Panel>
      {!win ? (
        <Empty title={preset === "latest" ? "No published runs yet" : "Pick a date range"}>{preset === "latest" ? "Publish a run to see its heatmaps, or choose another window." : "Choose a start and end date."}</Empty>
      ) : data.isLoading ? (
        <Spinner label="Loading cases…" />
      ) : data.error ? (
        <ErrorBox error={data.error} />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Cases in window" value={fmtInt(cur.length)} note={`${win.start} to ${win.end}`} />
            <Stat label="Previous window" value={fmtInt(filtered.length - cur.length)} note="same length, immediately before" />
            <Stat label="Busiest 4-hour band" value={`${String(conc.bandStart).padStart(2, "0")}:00–${String((conc.bandStart + 4) % 24).padStart(2, "0")}:00`} note={`${conc.bandShare.toFixed(0)}% of volume (${tzAbbrev(dtz)})`} />
            <Stat label="Busiest weekday" value={conc.topWeekday} note={`${conc.weekdayShare.toFixed(0)}% of volume`} />
          </div>
          <Panel title={HEAT_KINDS.find((k) => k.k === kind)!.label} sub={`${HEAT_KINDS.find((k) => k.k === kind)!.hint}. Click a cell for its cases.`}>
            {sortedRows && (
              <Heatmap
                g={sortedRows}
                compare={cgrid}
                showNumbers={nums}
                target={kind === "breachDensity" ? 5 : undefined}
                title={`${client.name} · ${HEAT_KINDS.find((k) => k.k === kind)!.label} · ${win.start} to ${win.end}`}
                fileStem={`heatmap_${kind}_${win.start}_${win.end}`}
                colLabel={colLabel}
                onCell={(r, c) => setDrill({ title: `${sortedRows.rows[r]} · ${colLabel(sortedRows.cols[c])}`, cases: cellCases(filtered, sortedRows, r, c, range!) })}
              />
            )}
            {kind === "breachDensity" && <p className="mt-2 text-[12px] text-muted">Diverging scale: green at or below 5% breached (the midpoint of typical 90–98% targets), red above. Hover shows evaluable counts.</p>}
          </Panel>
        </>
      )}
      {drill && (
        <Dialog open onOpenChange={(o) => !o && setDrill(null)} title={drill.title} description={`${fmtInt(drill.cases.length)} cases`} wide>
          <div className="max-h-[60vh] overflow-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Created</th>
                  <th>Title</th>
                  <th>Priority</th>
                  <th>Category</th>
                  {METRICS.map((m) => (
                    <th key={m.k}>{m.k}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {drill.cases.slice(0, 500).map((c, i) => (
                  <tr key={i}>
                    <td className="font-mono text-[12px]">{c.caseId}</td>
                    <td className="num text-[12px] whitespace-nowrap">{fmtInTz(c.ts.createdAt, dtz)} {tzAbbrev(dtz)}</td>
                    <td>{c.title}</td>
                    <td>{c.priority}</td>
                    <td>{c.category}</td>
                    {METRICS.map((m) => (
                      <td key={m.k}>
                        <StatusChip s={c.ev[m.k].s} why={c.ev[m.k].why} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Dialog>
      )}
    </div>
  );
}
