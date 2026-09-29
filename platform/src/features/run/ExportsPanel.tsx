import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, FileSpreadsheet, FileText, Presentation, Table2 } from "lucide-react";
import { supabase, must } from "@/lib/supabase";
import type { Artifact } from "@/lib/db";
import type { RunWorkspace } from "@/lib/useRun";
import { buildReportInput, fileStem, storeArtifact, type Comparison } from "@/lib/report";
import { buildWorkbook, buildExceptionReport, buildSlideTables } from "@/engine/export/workbook";
import { buildDeck } from "@/lib/deck";
import { downloadBlob } from "@/lib/download";
import { toCsv } from "@/engine/xlsx/writer";
import { METRICS } from "@/engine/types";
import { fmtInTz } from "@/engine/tz";
import { Button, Callout, Panel } from "@/components/ui";
import { fmtBytes, fmtDateTime } from "@/lib/format";

const KINDS: { k: string; label: string; icon: React.ReactNode; desc: string }[] = [
  { k: "workbook", label: "Processed workbook", icon: <FileSpreadsheet className="size-5" />, desc: "SLA compliance, cases, trends, heatmap and comparison (.xlsx)" },
  { k: "exceptions", label: "Exception report", icon: <FileText className="size-5" />, desc: "Every flagged item, every edit, excluded records and the reconciliation (.xlsx)" },
  { k: "slide_tables", label: "Slide-ready tables", icon: <Table2 className="size-5" />, desc: "The tables behind each slide (.xlsx)" },
  { k: "deck", label: "Service review deck", icon: <Presentation className="size-5" />, desc: "Generated PowerPoint in the monthly review format (.pptx)" },
  { k: "cases_csv", label: "Cases CSV", icon: <Download className="size-5" />, desc: "Every case with category and SLA status (.csv)" },
];

export function ExportsPanel({ ws, cmp, canStore }: { ws: RunWorkspace; cmp: Comparison | null | undefined; canStore: boolean }) {
  const { ctx, out } = ws;
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const arts = useQuery({
    queryKey: ["artifacts", ctx?.run.id],
    enabled: !!ctx,
    queryFn: async () => must(await supabase.from("run_artifacts").select("*").eq("run_id", ctx!.run.id).order("created_at", { ascending: false })) as Artifact[],
  });
  if (!ctx || !out) return null;
  const published = ctx.run.status === "published" || ctx.run.status === "superseded";

  const make = async (k: string) => {
    setBusy(k);
    try {
      const stem = fileStem(ctx);
      let blob: Blob, name: string;
      if (k === "cases_csv") {
        const tz = ctx.settings.displayTz;
        blob = new Blob(
          [
            toCsv([
              ["Row", "Case ID", "Title", "Priority", "Category", "Bucket", "Rule", "Created", "Disposition", "Excluded", ...METRICS.flatMap((m) => [`${m.k} s`, `${m.k} status`])],
              ...out.derived.map((d) => [d.rowNo, d.caseId, d.title, d.priority ?? "Invalid", d.category, d.bucket, d.ruleId, fmtInTz(d.ts.createdAt, tz), d.disposition, d.excluded ? d.excludedReason : "", ...METRICS.flatMap((m) => [d.ev[m.k].el ?? null, d.ev[m.k].s])]),
            ]),
          ],
          { type: "text/csv;charset=utf-8" },
        );
        name = `${stem}_cases.csv`;
      } else {
        const obs = ctx.run.observations?.filter((o) => o.include !== false).map((o) => o.text);
        const input = await buildReportInput(ctx, out, cmp ?? null, obs && obs.length ? obs : undefined);
        if (k === "workbook") [blob, name] = [await buildWorkbook(input), `${stem}.xlsx`];
        else if (k === "exceptions") [blob, name] = [await buildExceptionReport(input), `${stem}_exceptions.xlsx`];
        else if (k === "slide_tables") [blob, name] = [await buildSlideTables(input), `${stem}_slide_tables.xlsx`];
        else [blob, name] = [await buildDeck(input, ctx.run.report_text ?? {}), `${stem}.pptx`];
      }
      downloadBlob(blob, name);
      if (canStore) {
        await storeArtifact(ctx, k, name, blob).catch((e) => toast.error("Downloaded, but not stored with the run: " + e.message));
        qc.invalidateQueries({ queryKey: ["artifacts", ctx.run.id] });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const get = async (a: Artifact) => {
    const { data, error } = await supabase.storage.from("artifacts").download(a.file_path);
    if (error) return toast.error(error.message);
    downloadBlob(data, a.file_name);
  };
  const getSource = async () => {
    if (!ctx.run.source_file_path) return;
    const { data, error } = await supabase.storage.from("uploads").download(ctx.run.source_file_path);
    if (error) return toast.error(error.message);
    downloadBlob(data, ctx.run.source_file_name ?? "source");
  };
  return (
    <div className="flex flex-col gap-4">
      {!published && <Callout tone="warn" title="Draft exports.">This run isn't published yet, so these files reflect the current review state and are marked as drafts in their README.</Callout>}
      {out.counts.blockingOpen > 0 && <Callout tone="bad">{out.counts.blockingOpen} blocking exception(s) are open. Figures may be skewed until they're resolved.</Callout>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {KINDS.map((k) => (
          <div key={k.k} className="flex items-start gap-3 rounded-lg border border-line bg-surface p-4 shadow-card">
            <div className="text-accent">{k.icon}</div>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{k.label}</div>
              <div className="mb-2 text-[12.5px] text-muted">{k.desc}</div>
              <Button size="sm" variant="primary" loading={busy === k.k} disabled={!!busy} onClick={() => make(k.k)}>
                Generate and download
              </Button>
            </div>
          </div>
        ))}
      </div>
      <Panel title="Stored files" sub="Generated files saved with this run, and the original upload" pad={false}>
        <table className="tbl">
          <thead>
            <tr>
              <th>File</th>
              <th>Kind</th>
              <th className="r">Size</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {ctx.run.source_file_path && (
              <tr>
                <td>{ctx.run.source_file_name}</td>
                <td>Original upload</td>
                <td className="r num">{ctx.run.source_file_size ? fmtBytes(ctx.run.source_file_size) : "—"}</td>
                <td>{fmtDateTime(ctx.run.created_at)}</td>
                <td className="r">
                  <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={getSource}>
                    Download
                  </Button>
                </td>
              </tr>
            )}
            {(arts.data ?? []).map((a) => (
              <tr key={a.id}>
                <td>{a.file_name}</td>
                <td>{KINDS.find((k) => k.k === a.kind)?.label ?? a.kind}</td>
                <td className="r num">{a.size_bytes ? fmtBytes(a.size_bytes) : "—"}</td>
                <td>{fmtDateTime(a.created_at)}</td>
                <td className="r">
                  <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => get(a)}>
                    Download
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
