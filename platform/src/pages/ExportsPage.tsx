import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/lib/session";
import { supabase, must } from "@/lib/supabase";
import type { Artifact, Run } from "@/lib/db";
import { downloadBlob } from "@/lib/download";
import { periodLabel } from "@/engine/periods";
import { Button, Empty, ErrorBox, PageHeader, Panel, Spinner } from "@/components/ui";
import { RunStatusChip } from "@/components/RunBits";
import { fmtBytes, fmtDateTime } from "@/lib/format";

const KIND_LABEL: Record<string, string> = { workbook: "Processed workbook", exceptions: "Exception report", slide_tables: "Slide tables", deck: "Deck", cases_csv: "Cases CSV", heatmap_png: "Heatmap PNG", heatmap_csv: "Heatmap CSV" };

export default function ExportsPage() {
  const { client } = useSession();
  const q = useQuery({
    queryKey: ["exports", client?.id],
    enabled: !!client,
    queryFn: async () => {
      const runs = must(await supabase.from("runs").select("id,period_start,period_end,cadence,status,published_at").eq("client_id", client!.id).order("period_start", { ascending: false })) as Pick<Run, "id" | "period_start" | "period_end" | "cadence" | "status" | "published_at">[];
      const arts = runs.length ? (must(await supabase.from("run_artifacts").select("*").in("run_id", runs.map((r) => r.id)).order("created_at", { ascending: false })) as Artifact[]) : [];
      return runs.map((r) => ({ run: r, arts: arts.filter((a) => a.run_id === r.id) }));
    },
  });
  if (!client) return null;
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const get = async (a: Artifact) => {
    const { data, error } = await supabase.storage.from("artifacts").download(a.file_path);
    if (error) return toast.error(error.message);
    downloadBlob(data, a.file_name);
  };
  const rows = (q.data ?? []).filter((x) => x.arts.length || x.run.status === "published");
  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader eyebrow="Exports" title={`Generated files · ${client.name}`} sub="Workbooks, exception reports, slide tables and decks saved with each run. To generate a fresh file, open the run's Exports tab." />
      {!rows.length ? (
        <Empty title="No exports yet">Publishing a run generates its workbook, exception report, slide tables and deck automatically.</Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {rows.map(({ run, arts }) => (
            <Panel
              key={run.id}
              title={
                <span className="flex items-center gap-2">
                  <Link to={`/runs/${run.id}?tab=exports`} className="text-accent hover:underline">
                    {periodLabel({ start: run.period_start, end: run.period_end, cadence: run.cadence })}
                  </Link>
                  <RunStatusChip status={run.status} />
                </span>
              }
              pad={false}
            >
              {arts.length ? (
                <table className="tbl">
                  <tbody>
                    {arts.map((a) => (
                      <tr key={a.id}>
                        <td className="w-48">{KIND_LABEL[a.kind] ?? a.kind}</td>
                        <td>{a.file_name}</td>
                        <td className="r num w-24">{a.size_bytes ? fmtBytes(a.size_bytes) : ""}</td>
                        <td className="w-44 text-[12.5px] text-muted">{fmtDateTime(a.created_at)}</td>
                        <td className="r w-32">
                          <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => get(a)}>
                            Download
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="p-4 text-[13px] text-muted">No stored files. Open the run to generate them.</p>
              )}
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
