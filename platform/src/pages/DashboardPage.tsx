import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { AlertTriangle, CheckCircle2, FileUp, Upload } from "lucide-react";
import { supabase, must } from "@/lib/supabase";
import { useSession } from "@/lib/session";
import type { RunOverview } from "@/lib/db";
import { Button, Chip, Empty, ErrorBox, PageHeader, Panel, Spinner, Stat, cx } from "@/components/ui";
import { periodLabel } from "@/engine/periods";
import { fmtDateTime, fmtInt, fmtPct } from "@/lib/format";
import { RunStatusChip } from "@/components/RunBits";

export default function DashboardPage() {
  const { clientId, client, can, clients } = useSession();
  const nav = useNavigate();
  const q = useQuery({
    queryKey: ["run-overview"],
    queryFn: async () => must(await supabase.from("run_overview").select("*").order("period_start", { ascending: false }).order("created_at", { ascending: false }).limit(200)) as RunOverview[],
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const runs = q.data ?? [];
  const mine = runs.filter((r) => r.client_id === clientId);
  const inProgress = runs.filter((r) => ["draft", "staged", "review"].includes(r.status));
  const latestPublished = mine.find((r) => r.status === "published");
  const latestPerClient = clients
    .map((c) => ({ c, r: runs.find((r) => r.client_id === c.id && r.status === "published") }))
    .filter((x) => x.r);

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        eyebrow="Dashboard"
        title={client?.name ?? "Dashboard"}
        sub="Runs across your clients, their compliance and anything waiting for review."
        actions={can("own") && <Button variant="primary" icon={<Upload className="size-4" />} onClick={() => nav("/runs/new")}>Upload period data</Button>}
      />

      {latestPublished ? (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Latest period" value={<span className="text-[18px]">{periodLabel({ start: latestPublished.period_start, end: latestPublished.period_end, cadence: latestPublished.cadence })}</span>} note={latestPublished.cadence} />
          <Stat label="Cases" value={fmtInt(latestPublished.summary.total)} note={`${fmtInt(latestPublished.summary.informational)} Informational excluded`} />
          {(["TTA", "TTI", "TTC", "TTR"] as const).map((m) => (
            <Stat key={m} label={`${m} (all priorities)`} value={fmtPct(latestPublished.summary.overall?.[m] ?? null)} note="case-weighted" />
          ))}
        </div>
      ) : (
        !mine.length && (
          <div className="mb-6">
            <Empty
              icon={<FileUp className="size-8" />}
              title={`No runs for ${client?.name ?? "this client"} yet`}
              action={can("own") ? <Button variant="primary" onClick={() => nav("/runs/new")}>Start the first run</Button> : undefined}
            >
              Upload a weekly or monthly case export. The app maps the columns, categorizes every alert, checks the data and calculates SLA compliance.
            </Empty>
          </div>
        )
      )}

      {inProgress.length > 0 && (
        <Panel className="mb-6" title="In progress" sub="Runs that aren't published yet. Publishing stays blocked while any blocking exception is open.">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {inProgress.map((r) => (
              <RunCard key={r.id} r={r} showClient={r.client_id !== clientId} />
            ))}
          </div>
        </Panel>
      )}

      {latestPerClient.length > 1 && (
        <Panel className="mb-6" title="Clients at a glance" sub="Latest published period per client" pad={false}>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Period</th>
                  <th className="r">Cases</th>
                  <th className="r">TTA</th>
                  <th className="r">TTI</th>
                  <th className="r">TTC</th>
                  <th className="r">TTR</th>
                  <th>Targets</th>
                </tr>
              </thead>
              <tbody>
                {latestPerClient.map(({ c, r }) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/runs/${r!.id}`} className="font-medium text-accent hover:underline">{c.name}</Link>
                    </td>
                    <td>{periodLabel({ start: r!.period_start, end: r!.period_end, cadence: r!.cadence })}</td>
                    <td className="r num">{fmtInt(r!.summary.total)}</td>
                    {(["TTA", "TTI", "TTC", "TTR"] as const).map((m) => (
                      <td key={m} className="r num">{fmtPct(r!.summary.overall?.[m] ?? null)}</td>
                    ))}
                    <td>
                      <TargetsChip r={r!} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <Panel title={`Runs · ${client?.name ?? ""}`} sub="Most recent first" pad={false}>
        {mine.length ? (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Status</th>
                  <th className="r">Cases</th>
                  <th>Exceptions</th>
                  <th>Targets</th>
                  <th>Versions</th>
                  <th>Source file</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {mine.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/runs/${r.id}`} className="font-medium text-accent hover:underline">
                        {periodLabel({ start: r.period_start, end: r.period_end, cadence: r.cadence })}
                      </Link>
                      <div className="text-[12px] text-muted">{r.cadence}</div>
                    </td>
                    <td><RunStatusChip status={r.status} /></td>
                    <td className="r num">{fmtInt(r.summary.total ?? r.row_count)}</td>
                    <td>
                      <ExcChips b={r.blocking_open} n={r.nonblocking_open} status={r.status} />
                    </td>
                    <td><TargetsChip r={r} /></td>
                    <td className="text-[12px] text-ink-2">
                      {r.threshold_label ? `SLA v${r.threshold_version_no}` : "—"} · {r.ruleset_label ? `Rules v${r.ruleset_version_no}` : "—"}
                    </td>
                    <td className="max-w-56 truncate text-[12.5px]" title={r.source_file_name ?? ""}>{r.source_file_name ?? "—"}</td>
                    <td className="text-[12.5px] text-muted">{fmtDateTime(r.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="p-4 text-[13px] text-muted">No runs yet.</p>
        )}
      </Panel>
    </div>
  );
}

function ExcChips({ b, n, status }: { b: number; n: number; status: string }) {
  if (status === "published" || status === "superseded") return <span className="text-[12px] text-muted">Cleared</span>;
  if (status === "draft" || status === "staged") return <span className="text-[12px] text-muted">Not validated yet</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {b > 0 && <Chip tone="bad">{b} blocking</Chip>}
      {n > 0 && <Chip tone="warn">{n} to review</Chip>}
      {!b && !n && <Chip tone="good">Ready</Chip>}
    </span>
  );
}
function TargetsChip({ r }: { r: RunOverview }) {
  const s = r.summary;
  if (!s.targetsTotal) return <span className="text-[12px] text-muted">—</span>;
  return s.breaches ? (
    <Chip tone="bad">
      <AlertTriangle className="size-3" /> {s.breaches} of {s.targetsTotal} missed
    </Chip>
  ) : (
    <Chip tone="good">
      <CheckCircle2 className="size-3" /> All {s.targetsTotal} met
    </Chip>
  );
}

function RunCard({ r, showClient }: { r: RunOverview; showClient: boolean }) {
  return (
    <Link to={`/runs/${r.id}`} className={cx("block rounded-lg border border-line bg-surface-2 p-3 transition hover:border-accent")}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <b className="text-[14px]">{periodLabel({ start: r.period_start, end: r.period_end, cadence: r.cadence })}</b>
        <RunStatusChip status={r.status} />
      </div>
      {showClient && <div className="text-[12px] text-muted">{r.client_name}</div>}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
        <span className="num">{fmtInt(r.row_count)} rows</span>
        <ExcChips b={r.blocking_open} n={r.nonblocking_open} status={r.status} />
      </div>
      <div className="mt-1 truncate text-[12px] text-muted">{r.source_file_name}</div>
    </Link>
  );
}
