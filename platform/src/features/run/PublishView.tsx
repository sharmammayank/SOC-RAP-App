import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Lock, Send } from "lucide-react";
import type { RunWorkspace } from "@/lib/useRun";
import { publishRun } from "@/lib/runService";
import { buildReportInput, fileStem, runObservations, storeArtifact, type Comparison } from "@/lib/report";
import { buildWorkbook, buildExceptionReport, buildSlideTables } from "@/engine/export/workbook";
import { buildDeck, defaultDeckText, type DeckText } from "@/lib/deck";
import { Button, Callout, Chip, Label, Panel, Progress, Textarea } from "@/components/ui";
import { fmtInt } from "@/lib/format";
import { periodLabel } from "@/engine/periods";

export function PublishView({ ws, cmp, canPublish }: { ws: RunWorkspace; cmp: Comparison | null | undefined; canPublish: boolean }) {
  const { ctx, out } = ws;
  const qc = useQueryClient();
  const baseObs = useMemo(() => (ctx && out ? runObservations(ctx, out, cmp ?? null) : []), [ctx, out, cmp]);
  const [obs, setObs] = useState<{ text: string; include: boolean; kind: string; basis: unknown }[]>([]);
  const [text, setText] = useState<DeckText>({});
  const [progress, setProgress] = useState<{ pct: number; label: string } | null>(null);
  useEffect(() => setObs(baseObs.map((o) => ({ text: o.text, include: true, kind: o.kind, basis: o.basis }))), [baseObs]);
  useEffect(() => {
    if (ctx) setText((ctx.run.report_text as DeckText) ?? {});
  }, [ctx?.run.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ctx || !out) return null;
  const blocking = out.counts.blockingOpen;

  const publish = async () => {
    try {
      setProgress({ pct: 5, label: "Writing the compliance snapshot…" });
      const chosen = obs.filter((o) => o.include);
      await publishRun(
        ctx,
        out,
        chosen.map((o) => ({ kind: o.kind as never, text: o.text, weight: 0, basis: o.basis as Record<string, never> })),
        Object.fromEntries(Object.entries(text).filter(([, v]) => v && String(v).trim())) as Record<string, string>,
      );
      ws.setCtx(ctx);
      qc.invalidateQueries({ queryKey: ["run-overview"] });
      const input = await buildReportInput(ctx, out, cmp ?? null, chosen.map((o) => o.text));
      const stem = fileStem(ctx);
      const steps: [string, string, () => Promise<Blob>][] = [
        ["workbook", `${stem}.xlsx`, () => buildWorkbook(input)],
        ["exceptions", `${stem}_exceptions.xlsx`, () => buildExceptionReport(input)],
        ["slide_tables", `${stem}_slide_tables.xlsx`, () => buildSlideTables(input)],
        ["deck", `${stem}.pptx`, () => buildDeck(input, text)],
      ];
      for (let i = 0; i < steps.length; i++) {
        const [kind, name, fn] = steps[i];
        setProgress({ pct: 20 + (i / steps.length) * 75, label: `Generating ${name}…` });
        try {
          await storeArtifact(ctx, kind, name, await fn());
        } catch (e) {
          toast.error(`${name} couldn't be generated: ${e instanceof Error ? e.message : String(e)}. You can generate it again from Exports.`);
        }
      }
      setProgress(null);
      qc.invalidateQueries({ queryKey: ["artifacts", ctx.run.id] });
      toast.success(`${periodLabel(ctx.period)} published and locked`);
    } catch (e) {
      setProgress(null);
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const dt = defaultDeckText({ A: out.agg, P: cmp?.P ?? null } as never);
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex flex-col gap-4">
        <Panel title="Key observations" sub="Generated from the calculated values and ranked by materiality. Untick any you don't want in the report; edit wording if needed.">
          <ul className="flex flex-col gap-2">
            {obs.map((o, i) => (
              <li key={i} className="flex items-start gap-2">
                <input type="checkbox" className="mt-2.5" checked={o.include} aria-label={`Include observation ${i + 1}`} onChange={(e) => setObs(obs.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))} />
                <div className="flex-1">
                  <Textarea rows={2} value={o.text} onChange={(e) => setObs(obs.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} className="w-full text-[13px]" aria-label={`Observation ${i + 1}`} />
                  <div className="mt-0.5 flex gap-1">
                    <Chip>{o.kind}</Chip>
                    <span className="truncate font-mono text-[11px] text-muted" title={JSON.stringify(o.basis)}>
                      {JSON.stringify(o.basis)}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Deck text" sub="Leave blank to use the generated text shown as the placeholder.">
          <div className="grid gap-3 md:grid-cols-2">
            {(
              [
                ["slaTakeaway", "SLA slide: key takeaway"],
                ["slaNext", "SLA slide: next step"],
                ["sevTakeaway", "Severity slide: key takeaway"],
                ["sevNext", "Severity slide: next step"],
                ["catTakeaway", "Categories slide: extra takeaway"],
              ] as [keyof DeckText, string][]
            ).map(([k, l]) => (
              <div key={k} className="flex flex-col gap-1">
                <Label htmlFor={`dt-${k}`}>{l}</Label>
                <Textarea id={`dt-${k}`} rows={2} value={text[k] ?? ""} placeholder={dt[k]} onChange={(e) => setText({ ...text, [k]: e.target.value })} />
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <Panel title="Publish" className="h-fit xl:sticky xl:top-6">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13px]">
          <dt className="text-muted">Period</dt>
          <dd>{periodLabel(ctx.period)}</dd>
          <dt className="text-muted">SLA thresholds</dt>
          <dd>
            {ctx.threshold.label} · v{ctx.threshold.version_no}
          </dd>
          <dt className="text-muted">Rule set</dt>
          <dd>
            {ctx.ruleset.label} · v{ctx.ruleset.version_no}
          </dd>
          <dt className="text-muted">Imported rows</dt>
          <dd className="num">{fmtInt(out.counts.rows)}</dd>
          <dt className="text-muted">Cases reported</dt>
          <dd className="num">{fmtInt(out.counts.included)}</dd>
          <dt className="text-muted">SLA-evaluable</dt>
          <dd className="num">{fmtInt(out.counts.evaluable)}</dd>
          <dt className="text-muted">Excluded</dt>
          <dd className="num">{fmtInt(out.counts.rows - out.counts.included)} (explained in the exception report)</dd>
          <dt className="text-muted">Review edits</dt>
          <dd className="num">{fmtInt(ctx.editRows.length)}</dd>
          <dt className="text-muted">Source SHA-256</dt>
          <dd className="truncate font-mono text-[11.5px]" title={ctx.run.source_file_hash ?? ""}>
            {ctx.run.source_file_hash}
          </dd>
        </dl>
        <div className="mt-3 text-[12.5px] text-ink-2">
          Publishing locks the run and generates:
          <ul className="mt-1 list-disc pl-5">
            <li>Processed workbook</li>
            <li>Exception report with reconciliation</li>
            <li>Slide-ready tables</li>
            <li>Service review deck (PowerPoint)</li>
          </ul>
        </div>
        <div className="mt-4 flex flex-col gap-2">
          {blocking > 0 && (
            <Callout tone="bad" title={`${blocking} blocking exception${blocking > 1 ? "s" : ""} open.`}>
              Resolve them in Review before publishing.
            </Callout>
          )}
          {!canPublish && <Callout tone="info">Only a reporting owner can publish.</Callout>}
          {progress ? (
            <Progress value={progress.pct} label={progress.label} />
          ) : (
            <Button variant="primary" icon={blocking ? <Lock className="size-4" /> : <Send className="size-4" />} disabled={blocking > 0 || !canPublish || !!ws.busy} onClick={publish} title={blocking ? "Publish stays disabled while blocking exceptions are open" : undefined}>
              Publish and generate reports
            </Button>
          )}
        </div>
      </Panel>
    </div>
  );
}
