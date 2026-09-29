import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, History, RotateCcw, Save } from "lucide-react";
import { useSession } from "@/lib/session";
import { supabase, must } from "@/lib/supabase";
import type { Run, ThresholdVersion } from "@/lib/db";
import { METRICS, PRIORITIES, UNIT_LABEL, UNIT_SECONDS, type Limits, type Targets, type Unit } from "@/engine/types";
import { DEFAULT_LIMITS, DEFAULT_TARGETS, fmtLimit, limitError, limitWarnings, targetError } from "@/engine/defaults";
import { Button, Callout, Chip, Dialog, ErrorBox, Input, Label, PageHeader, Panel, PrioDot, Select, Spinner, Textarea, cx } from "@/components/ui";
import { fmtDate, fmtInt } from "@/lib/format";
import { periodLabel } from "@/engine/periods";

type Draft = { limits: Record<string, Record<string, { value: string; unit: Unit }>>; targets: Record<string, Record<string, string>> };
const toDraft = (l: Limits, t: Targets): Draft => ({
  limits: Object.fromEntries(PRIORITIES.map((p) => [p, Object.fromEntries(METRICS.map((m) => [m.k, { value: String(l[p][m.k].value), unit: l[p][m.k].unit }]))])),
  targets: Object.fromEntries(PRIORITIES.map((p) => [p, Object.fromEntries(METRICS.map((m) => [m.k, String(t[p][m.k])]))])),
});

export default function SlaConfigPage() {
  const { client, can, clients } = useSession();
  const qc = useQueryClient();
  const versions = useQuery({
    queryKey: ["thresholds", client?.id],
    enabled: !!client,
    queryFn: async () => must(await supabase.from("threshold_versions").select("*").eq("client_id", client!.id).order("version_no", { ascending: false })) as ThresholdVersion[],
  });
  const runs = useQuery({
    queryKey: ["runs-by-threshold", client?.id],
    enabled: !!client,
    queryFn: async () => must(await supabase.from("runs").select("id,threshold_version_id,period_start,period_end,cadence,status").eq("client_id", client!.id)) as Pick<Run, "id" | "threshold_version_id" | "period_start" | "period_end" | "cadence" | "status">[],
  });
  const current = versions.data?.[0];
  const [d, setD] = useState<Draft | null>(null);
  const [label, setLabel] = useState("");
  const [eff, setEff] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [histOpen, setHistOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (current) {
      setD(toDraft(current.limits, current.targets));
      setLabel(current.label);
    }
  }, [current]);
  const editable = can("own");

  const parsed = useMemo(() => {
    if (!d) return null;
    const errors: Record<string, string> = {};
    const limits = {} as Limits,
      targets = {} as Targets;
    for (const p of PRIORITIES) {
      limits[p] = {} as Limits[typeof p];
      targets[p] = {} as Targets[typeof p];
      for (const m of METRICS) {
        const c = d.limits[p][m.k],
          v = Number(c.value);
        const e = c.value.trim() === "" ? "Enter a value." : limitError(v, c.unit);
        if (e) errors[`l-${p}-${m.k}`] = e;
        limits[p][m.k] = { value: v, unit: c.unit, seconds: Math.round(v * UNIT_SECONDS[c.unit]) };
        const t = Number(d.targets[p][m.k]);
        const te = d.targets[p][m.k].trim() === "" ? "Enter a target." : targetError(t);
        if (te) errors[`t-${p}-${m.k}`] = te;
        targets[p][m.k] = t;
      }
    }
    return { limits, targets, errors, warnings: Object.keys(errors).length ? [] : limitWarnings(limits) };
  }, [d]);
  // Compare cell by cell: jsonb reorders object keys, so serialized forms can't be compared.
  const dirty = !!(
    parsed &&
    current &&
    PRIORITIES.some((p) =>
      METRICS.some((m) => {
        const a = parsed.limits[p][m.k],
          b = current.limits[p][m.k];
        return a.value !== b.value || a.unit !== b.unit || parsed.targets[p][m.k] !== current.targets[p][m.k];
      }),
    )
  );

  if (!client) return null;
  if (versions.isLoading || !d || !parsed) return versions.error ? <ErrorBox error={versions.error} /> : <Spinner />;

  const save = async () => {
    if (Object.keys(parsed.errors).length) return toast.error("Fix the highlighted cells first.");
    setSaving(true);
    try {
      must(await supabase.from("threshold_versions").insert({ client_id: client.id, version_no: 0, label: label.trim() || current!.label, effective_from: eff, limits: parsed.limits, targets: parsed.targets, notes }));
      await qc.invalidateQueries({ queryKey: ["thresholds", client.id] });
      qc.invalidateQueries({ queryKey: ["latest-versions", client.id] });
      setNotes("");
      toast.success("Saved as a new version. Existing runs keep the version they used.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const setCell = (p: string, m: string, patch: Partial<{ value: string; unit: Unit }>) => setD({ ...d, limits: { ...d.limits, [p]: { ...d.limits[p], [m]: { ...d.limits[p][m], ...patch } } } });
  const setTgt = (p: string, m: string, v: string) => setD({ ...d, targets: { ...d.targets, [p]: { ...d.targets[p], [m]: v } } });
  const usedBy = (vid: string) => (runs.data ?? []).filter((r) => r.threshold_version_id === vid);

  return (
    <div className="mx-auto max-w-[1300px]">
      <PageHeader
        eyebrow="Configuration"
        title={`SLA configuration · ${client.name}`}
        sub="Maximum limits per priority and metric, entered in seconds, minutes or hours and stored in seconds. Every save creates a new immutable version; past runs never change."
        actions={
          <>
            <Button icon={<History className="size-4" />} onClick={() => setHistOpen(true)}>
              Version history
            </Button>
            {editable && clients.length > 1 && (
              <Button icon={<Copy className="size-4" />} onClick={() => setCloneOpen(true)}>
                Clone from another client
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
        In force: <Chip tone="info">{current!.label}</Chip> version {current!.version_no}, effective {fmtDate(current!.effective_from)}. Used by {usedBy(current!.id).length} run(s).
      </div>
      {!editable && <div className="mb-4"><Callout>You have read-only access. Reporting owners and administrators can change thresholds.</Callout></div>}
      <Panel title="Maximum limits" sub="A case MEETS a metric when its elapsed time is at or below the limit. Informational cases are excluded from SLA." actions={editable && <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => setD(toDraft(DEFAULT_LIMITS, DEFAULT_TARGETS))}>Spec baseline</Button>}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-[13px]">
            <thead>
              <tr className="text-left text-[11.5px] tracking-wide text-muted uppercase">
                <th className="py-2 pr-3">Priority</th>
                {METRICS.map((m) => (
                  <th key={m.k} className="px-2 py-2">
                    {m.k} · {m.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PRIORITIES.map((p) => (
                <tr key={p} className="border-t border-line">
                  <td className="py-3 pr-3 font-semibold">
                    <PrioDot p={p} />
                    {p}
                  </td>
                  {METRICS.map((m) => {
                    const c = d.limits[p][m.k];
                    const e = parsed.errors[`l-${p}-${m.k}`];
                    const secs = parsed.limits[p][m.k].seconds;
                    return (
                      <td key={m.k} className="px-2 py-3 align-top">
                        <div className="flex gap-1">
                          <Input type="number" min="0" step="any" disabled={!editable} value={c.value} aria-label={`${p} ${m.k} value`} aria-invalid={!!e} onChange={(ev) => setCell(p, m.k, { value: ev.target.value })} className={cx("w-24", e && "border-bad")} />
                          <Select disabled={!editable} value={c.unit} aria-label={`${p} ${m.k} unit`} onChange={(ev) => setCell(p, m.k, { unit: ev.target.value as Unit })}>
                            {(Object.keys(UNIT_LABEL) as Unit[]).map((u) => (
                              <option key={u} value={u}>
                                {UNIT_LABEL[u]}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <div className={cx("num mt-1 text-[12px]", e ? "text-bad" : "text-muted")} aria-live="polite">
                          {e ?? `= ${fmtInt(secs)} seconds`}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr className="border-t border-line">
                <td className="py-3 pr-3 font-semibold">
                  <PrioDot p="Informational" />
                  Informational
                </td>
                <td colSpan={4} className="px-2 py-3 text-muted">
                  Not applicable. Excluded from every compliance denominator; still counted in volume.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {parsed.warnings.length > 0 && (
          <div className="mt-3">
            <Callout tone="warn" title="Check:">
              {parsed.warnings.join("; ")}. This is allowed but unusual.
            </Callout>
          </div>
        )}
      </Panel>
      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel title="Compliance targets" sub="Percent of evaluable cases that must meet the limit. One decimal place, 0–100.">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11.5px] tracking-wide text-muted uppercase">
                <th className="py-2">Priority</th>
                {METRICS.map((m) => (
                  <th key={m.k} className="px-2 py-2">
                    {m.k} target %
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PRIORITIES.map((p) => (
                <tr key={p} className="border-t border-line">
                  <td className="py-2 font-semibold">{p}</td>
                  {METRICS.map((m) => {
                    const e = parsed.errors[`t-${p}-${m.k}`];
                    return (
                      <td key={m.k} className="px-2 py-2">
                        <Input type="number" min="0" max="100" step="0.1" disabled={!editable} value={d.targets[p][m.k]} aria-label={`${p} ${m.k} target`} aria-invalid={!!e} title={e} onChange={(ev) => setTgt(p, m.k, ev.target.value)} className={cx("w-24", e && "border-bad")} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        {editable && (
          <Panel title="Save as a new version" className="h-fit">
            <div className="flex flex-col gap-3">
              <div>
                <Label htmlFor="lbl">Version label</Label>
                <Input id="lbl" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} className="mt-1 w-full" />
              </div>
              <div>
                <Label htmlFor="eff">Effective from</Label>
                <Input id="eff" type="date" value={eff} onChange={(e) => setEff(e.target.value)} className="mt-1 w-full" />
              </div>
              <div>
                <Label htmlFor="notes">Notes</Label>
                <Textarea id="notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Why the change, who agreed it" className="mt-1 w-full" />
              </div>
              <Button variant="primary" icon={<Save className="size-4" />} disabled={!dirty || !!Object.keys(parsed.errors).length} loading={saving} onClick={save}>
                Save version {current!.version_no + 1}
              </Button>
              {!dirty && <p className="text-[12px] text-muted">No changes from the version in force.</p>}
            </div>
          </Panel>
        )}
      </div>

      <Dialog open={histOpen} onOpenChange={setHistOpen} title="Threshold version history" wide>
        <table className="tbl">
          <thead>
            <tr>
              <th>Version</th>
              <th>Label</th>
              <th>Effective</th>
              <th>Saved</th>
              <th>Changes vs previous</th>
              <th>Runs</th>
            </tr>
          </thead>
          <tbody>
            {(versions.data ?? []).map((v, i, arr) => {
              const prev = arr[i + 1];
              const changes = prev
                ? PRIORITIES.flatMap((p) =>
                    METRICS.flatMap((m) => [
                      v.limits[p][m.k].seconds !== prev.limits[p][m.k].seconds ? `${p} ${m.k} ${fmtLimit(prev.limits[p][m.k])} → ${fmtLimit(v.limits[p][m.k])}` : null,
                      v.targets[p][m.k] !== prev.targets[p][m.k] ? `${p} ${m.k} target ${prev.targets[p][m.k]}% → ${v.targets[p][m.k]}%` : null,
                    ]),
                  ).filter(Boolean)
                : ["Initial version"];
              return (
                <tr key={v.id}>
                  <td className="num">v{v.version_no}</td>
                  <td>{v.label}</td>
                  <td>{fmtDate(v.effective_from)}</td>
                  <td className="text-[12.5px]">{fmtDate(v.created_at)}</td>
                  <td className="text-[12px]">
                    {changes.length ? changes.join("; ") : "No limit or target changes"}
                    {v.notes && <div className="text-muted">{v.notes}</div>}
                  </td>
                  <td className="text-[12px]">
                    {usedBy(v.id)
                      .map((r) => periodLabel({ start: r.period_start, end: r.period_end, cadence: r.cadence }))
                      .join(", ") || "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Dialog>
      <CloneDialog open={cloneOpen} setOpen={setCloneOpen} targetId={client.id} />
    </div>
  );
}

export function CloneDialog({ open, setOpen, targetId, rulesDefault = false }: { open: boolean; setOpen: (o: boolean) => void; targetId: string; rulesDefault?: boolean }) {
  const { clients } = useSession();
  const qc = useQueryClient();
  const others = clients.filter((c) => c.id !== targetId);
  const [from, setFrom] = useState(others[0]?.id ?? "");
  const [thr, setThr] = useState(!rulesDefault);
  const [rules, setRules] = useState(rulesDefault);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      must(await supabase.rpc("clone_client_config", { p_from: from, p_to: targetId, p_thresholds: thr, p_rules: rules }));
      qc.invalidateQueries();
      toast.success("Configuration cloned as new versions");
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Clone configuration"
      description="Copies the source client's latest versions into this client as new versions. Existing runs are unaffected."
      footer={
        <>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!from || (!thr && !rules)} onClick={go}>
            Clone
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Label htmlFor="clone-from">From client</Label>
        <Select id="clone-from" value={from} onChange={(e) => setFrom(e.target.value)}>
          {others.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={thr} onChange={(e) => setThr(e.target.checked)} /> SLA limits and targets
        </label>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={rules} onChange={(e) => setRules(e.target.checked)} /> Category rule set (replaces any unpublished draft)
        </label>
      </div>
    </Dialog>
  );
}
