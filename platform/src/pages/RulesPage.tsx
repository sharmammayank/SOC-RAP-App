import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Copy, FileDown, FileUp, GripVertical, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { useSession } from "@/lib/session";
import { supabase, must, fetchAll } from "@/lib/supabase";
import type { RulesetVersion, Run } from "@/lib/db";
import type { Rule } from "@/engine/types";
import { categoryDiff, checkPattern, classify, compileRules, normTitle, regressionTest, sanitizeRules, type Movement, type RegressionFailure } from "@/engine/rules";
import { getOrCreateDraft, nextLabel, nextUserRuleId } from "@/lib/rulesService";
import { downloadBlob } from "@/lib/download";
import { Button, Callout, Chip, CsvButton, Dialog, ErrorBox, Input, Label, PageHeader, Panel, Segmented, Spinner, Textarea, cx } from "@/components/ui";
import { CloneDialog } from "./SlaConfigPage";
import { fmtDateTime, fmtInt } from "@/lib/format";
import { periodLabel } from "@/engine/periods";

export default function RulesPage() {
  const { client, can, clients } = useSession();
  const qc = useQueryClient();
  const editable = can("own");
  const q = useQuery({
    queryKey: ["rulesets", client?.id],
    enabled: !!client,
    queryFn: async () => must(await supabase.from("ruleset_versions").select("*").eq("client_id", client!.id).order("created_at", { ascending: false })) as RulesetVersion[],
  });
  // Match counts and the regression diff use the most recent run's titles.
  const lastRun = useQuery({
    queryKey: ["rules-last-run", client?.id],
    enabled: !!client,
    queryFn: async () => {
      const r = must(await supabase.from("runs").select("id,period_start,period_end,cadence,status").eq("client_id", client!.id).in("status", ["published", "review"]).order("period_start", { ascending: false }).limit(1).maybeSingle()) as Pick<Run, "id" | "period_start" | "period_end" | "cadence" | "status"> | null;
      if (!r) return null;
      const rows = await fetchAll<{ title: string; matched_rule_id: string }>((f, t) => supabase.from("case_derived").select("title,matched_rule_id").eq("run_id", r.id).eq("excluded", false).range(f, t));
      const titles = new Map<string, number>(),
        counts = new Map<string, number>();
      for (const x of rows) {
        titles.set(x.title, (titles.get(x.title) ?? 0) + 1);
        counts.set(x.matched_rule_id, (counts.get(x.matched_rule_id) ?? 0) + 1);
      }
      return { run: r, titles, counts };
    },
  });
  const published = q.data?.filter((v) => v.status === "published").sort((a, b) => (b.version_no ?? 0) - (a.version_no ?? 0)) ?? [];
  const draft = q.data?.find((v) => v.status === "draft") ?? null;
  const [view, setView] = useState<"draft" | "published">("published");
  const shown = view === "draft" && draft ? draft : published[0];
  const [edit, setEdit] = useState<Rule | "new" | null>(null);
  const [pubOpen, setPubOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [pending, setPending] = useState<Rule[] | null>(null);

  if (!client) return null;
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (!shown) return <ErrorBox error="No rule set found for this client." />;

  const isDraftView = view === "draft" && !!draft;
  const rules = (pending ?? shown.rules).slice().sort((a, b) => a.precedence - b.precedence || (a.rule_id < b.rule_id ? -1 : 1));

  const saveDraft = async (next: Rule[], msg: string) => {
    setSaving(true);
    try {
      const d = draft ?? (await getOrCreateDraft(client.id));
      must(await supabase.from("ruleset_versions").update({ rules: next }).eq("id", d.id));
      await qc.invalidateQueries({ queryKey: ["rulesets", client.id] });
      setView("draft");
      setPending(null);
      toast.success(msg);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const startDraft = async () => {
    try {
      await getOrCreateDraft(client.id);
      await qc.invalidateQueries({ queryKey: ["rulesets", client.id] });
      setView("draft");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  const discard = async () => {
    if (!draft) return;
    must(await supabase.from("ruleset_versions").delete().eq("id", draft.id));
    await qc.invalidateQueries({ queryKey: ["rulesets", client.id] });
    setView("published");
    setPending(null);
    toast.success("Draft discarded");
  };
  // Reorder: dropped rule takes a precedence between its new neighbours; the full list is renumbered when there's no gap.
  const move = (id: string, toIndex: number) => {
    const list = rules.filter((r) => r.rule_id !== id);
    const r = rules.find((x) => x.rule_id === id)!;
    list.splice(toIndex, 0, r);
    const prev = list[toIndex - 1]?.precedence ?? 0,
      next = list[toIndex + 1]?.precedence ?? prev + 20;
    let out: Rule[];
    if (next - prev >= 2) out = list.map((x) => (x.rule_id === id ? { ...x, precedence: Math.floor((prev + next) / 2) } : x));
    else out = list.map((x, i) => ({ ...x, precedence: (i + 1) * 10 }));
    setPending(out);
  };
  const precedenceChanges = pending ? pending.filter((r) => shown.rules.find((o) => o.rule_id === r.rule_id)?.precedence !== r.precedence) : [];
  const exportJson = () => downloadBlob(new Blob([JSON.stringify({ label: shown.label, status: shown.status, version_no: shown.version_no, exported_at: new Date().toISOString(), client: client.name, rules: shown.rules }, null, 1)], { type: "application/json" }), `rules_${client.name}_${shown.label}.json`);
  const importJson = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 2_000_000) return toast.error("That file is too large for a rule set.");
    try {
      const { rules: rs, errors } = sanitizeRules(JSON.parse(await f.text()));
      if (!rs.length) return toast.error(errors[0] ?? "No valid rules found.");
      await saveDraft(rs, `Imported ${rs.length} rules into the draft${errors.length ? ` (${errors.length} skipped: ${errors.slice(0, 3).join("; ")})` : ""}`);
    } catch (e) {
      toast.error("That isn't a valid rules JSON file: " + (e instanceof Error ? e.message : ""));
    }
  };

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        eyebrow="Configuration"
        title={`Category rules · ${client.name}`}
        sub="Ordered regex rules classify each alert by the tool or technology that produced it. Titles are normalized first (invisible characters removed, lowercase, separators become spaces). The lowest precedence that matches wins; no match means Uncategorized and manual review."
        actions={
          <>
            <Button icon={<FileDown className="size-4" />} onClick={exportJson}>
              Export JSON
            </Button>
            {editable && (
              <>
                <Button icon={<FileUp className="size-4" />} onClick={() => fileRef.current?.click()}>
                  Import JSON
                </Button>
                <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => importJson(e.target.files?.[0])} aria-label="Import rules JSON" />
                {clients.length > 1 && (
                  <Button icon={<Copy className="size-4" />} onClick={() => setCloneOpen(true)}>
                    Clone from client
                  </Button>
                )}
              </>
            )}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented
          label="Version"
          value={isDraftView ? "draft" : "published"}
          onChange={(v) => {
            setPending(null);
            setView(v);
          }}
          options={[
            { v: "published", label: `Published · ${published[0]?.label} v${published[0]?.version_no}` },
            { v: "draft", label: draft ? `Draft · ${draft.label}` : "No draft", disabled: !draft },
          ]}
        />
        {editable && !draft && (
          <Button size="sm" onClick={startDraft}>
            Start a draft
          </Button>
        )}
        {editable && isDraftView && (
          <>
            <Button size="sm" variant="primary" icon={<Send className="size-3.5" />} onClick={() => setPubOpen(true)} disabled={!!pending}>
              Test and publish draft
            </Button>
            <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={discard}>
              Discard draft
            </Button>
          </>
        )}
        <span className="text-[12.5px] text-muted">
          {shown.rules.length} rules · {shown.status === "published" ? `published ${fmtDateTime(shown.published_at)}` : `draft updated ${fmtDateTime(shown.updated_at)}`}
          {lastRun.data && ` · match counts from ${periodLabel({ start: lastRun.data.run.period_start, end: lastRun.data.run.period_end, cadence: lastRun.data.run.cadence })}`}
        </span>
      </div>
      {!isDraftView && editable && <div className="mb-4"><Callout>Published versions are immutable. Start a draft to change rules; runs keep the version they recorded.</Callout></div>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
        <Panel
          title="Rules in precedence order"
          sub={isDraftView && editable ? "Drag a row (or use the arrows) to change precedence. Review the change, then save it to the draft." : undefined}
          actions={
            <>
              <CsvButton name={`rules_${shown.label}`} rows={() => [["Precedence", "Rule", "Category", "Sub-category", "Bucket", "Pattern", "Fields", "Enabled", "Last-run matches"], ...rules.map((r) => [r.precedence, r.rule_id, r.category, r.subcategory ?? "", r.report_bucket, r.pattern, (r.fields ?? ["title"]).join("+"), r.enabled !== false, lastRun.data?.counts.get(r.rule_id) ?? 0])]} />
              {isDraftView && editable && (
                <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEdit("new")}>
                  Add rule
                </Button>
              )}
            </>
          }
          pad={false}
        >
          {pending && (
            <div className="border-b border-line px-4 py-3">
              <Callout
                tone="warn"
                title={`${precedenceChanges.length} precedence change${precedenceChanges.length === 1 ? "" : "s"} not saved.`}
                action={
                  <span className="flex gap-2">
                    <Button size="sm" onClick={() => setPending(null)}>
                      Undo
                    </Button>
                    <Button size="sm" variant="primary" loading={saving} onClick={() => saveDraft(pending, "Precedence saved to the draft")}>
                      Save order
                    </Button>
                  </span>
                }
              >
                {precedenceChanges
                  .slice(0, 6)
                  .map((r) => `${r.rule_id}: ${shown.rules.find((o) => o.rule_id === r.rule_id)?.precedence} → ${r.precedence}`)
                  .join(" · ")}
                {precedenceChanges.length > 6 ? " …" : ""}
              </Callout>
            </div>
          )}
          <div className="max-h-[72vh] overflow-auto">
            <table className="tbl">
              <thead>
                <tr>
                  {isDraftView && editable && <th aria-label="Reorder" />}
                  <th>On</th>
                  <th className="r">Prec.</th>
                  <th>Rule</th>
                  <th>Category · bucket</th>
                  <th>Pattern</th>
                  <th className="r">Matches</th>
                  {isDraftView && editable && <th />}
                </tr>
              </thead>
              <tbody>
                {rules.map((r, i) => (
                  <tr
                    key={r.rule_id}
                    draggable={isDraftView && editable}
                    onDragStart={() => setDragId(r.rule_id)}
                    onDragOver={(e) => isDraftView && e.preventDefault()}
                    onDrop={() => {
                      if (dragId && dragId !== r.rule_id) move(dragId, i);
                      setDragId(null);
                    }}
                    className={cx(r.enabled === false && "opacity-50", dragId === r.rule_id && "bg-accent-soft")}
                  >
                    {isDraftView && editable && (
                      <td className="whitespace-nowrap text-muted">
                        <GripVertical className="inline size-4 cursor-grab" aria-hidden />
                        <button type="button" aria-label={`Move ${r.rule_id} up`} disabled={i === 0} onClick={() => move(r.rule_id, i - 1)} className="rounded p-0.5 hover:bg-surface-2 disabled:opacity-30">
                          <ArrowUp className="size-3.5" />
                        </button>
                        <button type="button" aria-label={`Move ${r.rule_id} down`} disabled={i === rules.length - 1} onClick={() => move(r.rule_id, i + 1)} className="rounded p-0.5 hover:bg-surface-2 disabled:opacity-30">
                          <ArrowDown className="size-3.5" />
                        </button>
                      </td>
                    )}
                    <td>
                      <input
                        type="checkbox"
                        checked={r.enabled !== false}
                        disabled={!isDraftView || !editable || saving}
                        aria-label={`Enable ${r.rule_id}`}
                        onChange={(e) => saveDraft(rules.map((x) => (x.rule_id === r.rule_id ? { ...x, enabled: e.target.checked } : x)), `${r.rule_id} ${e.target.checked ? "enabled" : "disabled"} in the draft`)}
                      />
                    </td>
                    <td className="r num">{r.precedence}</td>
                    <td className="font-mono text-[12px] whitespace-nowrap">{r.rule_id}</td>
                    <td>
                      <div>{r.category}</div>
                      <div className="text-[12px] text-muted">
                        {r.subcategory ? `${r.subcategory} · ` : ""}
                        {r.report_bucket}
                        {r.fields?.includes("description") ? " · also description" : ""}
                      </div>
                    </td>
                    <td className="max-w-[420px] font-mono text-[11.5px] break-all">{r.pattern}</td>
                    <td className="r num">{fmtInt(lastRun.data?.counts.get(r.rule_id) ?? 0)}</td>
                    {isDraftView && editable && (
                      <td className="whitespace-nowrap">
                        <Button size="sm" variant="ghost" aria-label={`Edit ${r.rule_id}`} icon={<Pencil className="size-3.5" />} onClick={() => setEdit(r)} />
                        <Button size="sm" variant="ghost" aria-label={`Delete ${r.rule_id}`} icon={<Trash2 className="size-3.5" />} onClick={() => saveDraft(rules.filter((x) => x.rule_id !== r.rule_id), `${r.rule_id} removed from the draft`)} />
                      </td>
                    )}
                  </tr>
                ))}
                <tr>
                  {isDraftView && editable && <td />}
                  <td />
                  <td className="r num">999</td>
                  <td className="font-mono text-[12px]">CAT-FALLBACK</td>
                  <td>Uncategorized</td>
                  <td className="text-[12px] text-muted">No rule matched: goes to review</td>
                  <td className="r num">{fmtInt(lastRun.data?.counts.get("CAT-FALLBACK") ?? 0)}</td>
                  {isDraftView && editable && <td />}
                </tr>
              </tbody>
            </table>
          </div>
        </Panel>
        <Tester rules={rules} label={isDraftView ? "draft" : "published"} />
      </div>
      {edit && <RuleDialog rule={edit === "new" ? null : edit} rules={rules} onClose={() => setEdit(null)} onSave={(r, msg) => saveDraft(edit === "new" ? [...rules, r] : rules.map((x) => (x.rule_id === r.rule_id ? r : x)), msg).then(() => setEdit(null))} />}
      {pubOpen && draft && <PublishDialog draft={draft} base={published[0]} titles={lastRun.data?.titles ?? new Map()} runLabel={lastRun.data ? periodLabel({ start: lastRun.data.run.period_start, end: lastRun.data.run.period_end, cadence: lastRun.data.run.cadence }) : null} onClose={() => setPubOpen(false)} onDone={() => { setView("published"); qc.invalidateQueries({ queryKey: ["rulesets", client.id] }); qc.invalidateQueries({ queryKey: ["latest-versions", client.id] }); }} />}
      <CloneDialog open={cloneOpen} setOpen={setCloneOpen} targetId={client.id} rulesDefault />
    </div>
  );
}

function Tester({ rules, label }: { rules: Rule[]; label: string }) {
  const [text, setText] = useState("");
  const compiled = useMemo(() => compileRules(rules).compiled, [rules]);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 50);
  return (
    <Panel title="Test titles" sub={`Paste one alert title per line. Uses the ${label} rules as shown, including unsaved order changes.`} className="h-fit xl:sticky xl:top-6">
      <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={"HD011_ProofPoint_TAP_threat_email_delivered\naccount_lockouts detected on DC01"} className="w-full font-mono text-[12.5px]" aria-label="Titles to test" />
      <div className="mt-3 flex flex-col gap-2" aria-live="polite">
        {lines.map((t, i) => {
          const c = classify(t, compiled, { audit: true });
          return (
            <div key={i} className="rounded-md bg-surface-2 px-3 py-2 text-[12.5px]">
              <div className="flex flex-wrap items-center gap-2">
                <b>{c.category}</b>
                <span className="text-muted">bucket {c.bucket}</span>
                <span className="font-mono">{c.ruleId}</span>
                {c.ambiguous && <Chip tone="warn">ambiguous</Chip>}
              </div>
              <div className="font-mono text-[11.5px] text-muted">
                “{normTitle(t)}”{c.match && <> · matched “{c.match}”</>}
              </div>
              {!!c.alsoMatched?.length && <div className="text-[11.5px] text-muted">Also matches: {c.alsoMatched.join(", ")}</div>}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function RuleDialog({ rule, rules, onClose, onSave }: { rule: Rule | null; rules: Rule[]; onClose: () => void; onSave: (r: Rule, msg: string) => void }) {
  const [r, setR] = useState<Rule>(
    rule ?? { rule_id: nextUserRuleId(rules), category: "", subcategory: "", report_bucket: "Other", pattern: "", precedence: 270, fields: ["title"], enabled: true, case_sensitive: false, notes: "", sample_titles: [] },
  );
  const [samples, setSamples] = useState((rule?.sample_titles ?? []).join("\n"));
  const perr = r.pattern ? checkPattern(r.pattern) : "Enter a pattern.";
  const sampleList = samples.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const sampleResults = useMemo(() => {
    if (perr) return [];
    const compiled = compileRules([...rules.filter((x) => x.rule_id !== r.rule_id), r]).compiled;
    return sampleList.map((t) => ({ t, c: classify(t, compiled) }));
  }, [perr, rules, r, samples]); // eslint-disable-line react-hooks/exhaustive-deps
  const idErr = !/^[A-Z0-9][A-Z0-9_-]{1,59}$/.test(r.rule_id) ? "Use A–Z, 0–9, - or _." : !rule && rules.some((x) => x.rule_id === r.rule_id) ? "That ID is taken." : null;
  const ok = !perr && !idErr && r.category.trim() && Number.isInteger(r.precedence);
  const set = (p: Partial<Rule>) => setR({ ...r, ...p });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={rule ? `Edit ${rule.rule_id}` : "Add rule"}
      description="Rules identify the control that produced the alert (vendor first), not the attack behaviour."
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ok} onClick={() => onSave({ ...r, category: r.category.trim(), sample_titles: sampleList }, `${r.rule_id} saved to the draft`)}>
            Save to draft
          </Button>
        </>
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor="r-id">Rule ID</Label>
          <Input id="r-id" value={r.rule_id} disabled={!!rule} onChange={(e) => set({ rule_id: e.target.value.toUpperCase() })} className="mt-1 w-full font-mono" />
          {idErr && <p className="text-[12px] text-bad">{idErr}</p>}
        </div>
        <div>
          <Label htmlFor="r-prec" hint="Lower runs first. Vendors 100–299, SecOps 300–699, technologies 700+.">Precedence</Label>
          <Input id="r-prec" type="number" value={r.precedence} onChange={(e) => set({ precedence: Math.round(Number(e.target.value)) })} className="mt-1 w-full" />
        </div>
        <div>
          <Label htmlFor="r-cat">Category</Label>
          <Input id="r-cat" value={r.category} onChange={(e) => set({ category: e.target.value })} className="mt-1 w-full" maxLength={100} />
        </div>
        <div>
          <Label htmlFor="r-sub">Sub-category</Label>
          <Input id="r-sub" value={r.subcategory ?? ""} onChange={(e) => set({ subcategory: e.target.value })} className="mt-1 w-full" maxLength={100} />
        </div>
        <div>
          <Label htmlFor="r-bkt" hint="The group used on report slides">Report bucket</Label>
          <Input id="r-bkt" value={r.report_bucket} onChange={(e) => set({ report_bucket: e.target.value })} className="mt-1 w-full" maxLength={100} />
        </div>
        <div className="flex flex-col gap-1.5 pt-5 text-[13px]">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!r.fields?.includes("description")} onChange={(e) => set({ fields: e.target.checked ? ["title", "description"] : ["title"] })} /> Also search the description
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!r.case_sensitive} onChange={(e) => set({ case_sensitive: e.target.checked })} /> Case-sensitive
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={r.enabled !== false} onChange={(e) => set({ enabled: e.target.checked })} /> Enabled
          </label>
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="r-pat" hint="Applied to the normalized title (lowercase letters, digits and single spaces). Use \\b for word edges and ' ?' for optional separators.">
            Pattern
          </Label>
          <Input id="r-pat" value={r.pattern} onChange={(e) => set({ pattern: e.target.value })} className={cx("mt-1 w-full font-mono", perr && r.pattern && "border-bad")} aria-invalid={!!perr} />
          <p className={cx("mt-1 text-[12px]", perr ? "text-bad" : "text-good")} aria-live="polite">
            {perr ?? "Valid and safe."}
          </p>
        </div>
        <div>
          <Label htmlFor="r-samples" hint="One per line. Publishing checks each still resolves to this category.">Sample titles</Label>
          <Textarea id="r-samples" rows={4} value={samples} onChange={(e) => setSamples(e.target.value)} className="mt-1 w-full font-mono text-[12px]" />
        </div>
        <div className="flex flex-col gap-1 text-[12.5px]">
          <span className="text-muted">Sample results with this rule in place</span>
          {sampleResults.map(({ t, c }, i) => (
            <div key={i} className={cx("rounded px-2 py-1", c.category === r.category ? "bg-good-bg" : "bg-bad-bg")}>
              <span className="font-mono">{t.slice(0, 60)}</span> → {c.category} ({c.ruleId})
            </div>
          ))}
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="r-notes">Notes (intent, owner, review date)</Label>
          <Textarea id="r-notes" rows={2} value={r.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} className="mt-1 w-full" />
        </div>
      </div>
    </Dialog>
  );
}

function PublishDialog({ draft, base, titles, runLabel, onClose, onDone }: { draft: RulesetVersion; base: RulesetVersion; titles: Map<string, number>; runLabel: string | null; onClose: () => void; onDone: () => void }) {
  const [label, setLabel] = useState(draft.label === base.label ? nextLabel(base.label) : draft.label);
  const [notes, setNotes] = useState(draft.notes);
  const [busy, setBusy] = useState(false);
  const failures: RegressionFailure[] = useMemo(() => regressionTest(draft.rules), [draft.rules]);
  const moves: Movement[] = useMemo(() => categoryDiff(titles, base.rules, draft.rules), [titles, base.rules, draft.rules]);
  const rejected = useMemo(() => compileRules(draft.rules).rejected, [draft.rules]);
  const moved = moves.reduce((a, m) => a + m.count, 0);
  const publish = async () => {
    setBusy(true);
    try {
      must(
        await supabase
          .from("ruleset_versions")
          .update({ status: "published", label: label.trim(), notes, publish_check: { regression: { failures: failures.length, samples: draft.rules.reduce((a, r) => a + (r.sample_titles?.length ?? 0), 0) }, diff: { against: runLabel, titles: titles.size, moved, movements: moves.slice(0, 200) } } })
          .eq("id", draft.id),
      );
      toast.success(`${label} published. New runs use it; existing runs keep their version.`);
      onDone();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Publish rule set"
      description="The regression test and the category-movement diff must be reviewed before the draft becomes an immutable version."
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={failures.length > 0 || rejected.length > 0 || !label.trim()} onClick={publish}>
            Publish {label}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {failures.length ? (
          <Callout tone="bad" title={`Regression failed: ${failures.length} sample title${failures.length > 1 ? "s" : ""} no longer resolve to their rule's category.`}>
            <ul className="mt-1 list-disc pl-5">
              {failures.slice(0, 10).map((f, i) => (
                <li key={i}>
                  <span className="font-mono">{f.rule_id}</span>: “{f.title}” → {f.got} ({f.gotRule}), expected {f.expected}
                </li>
              ))}
            </ul>
          </Callout>
        ) : (
          <Callout tone="good" title="Regression passed.">
            Every rule's sample titles still resolve to their expected category.
          </Callout>
        )}
        {rejected.length > 0 && <Callout tone="bad" title="Unsafe or invalid patterns.">{rejected.map((r) => `${r.rule_id}: ${r.error}`).join(" · ")}</Callout>}
        <div>
          <h4 className="mb-1 text-[14px]">Category movements {runLabel ? `on ${runLabel}'s titles` : ""}</h4>
          {!runLabel ? (
            <p className="text-[13px] text-muted">No earlier run to compare against.</p>
          ) : moves.length ? (
            <>
              <p className="mb-2 text-[13px] text-ink-2">
                {fmtInt(moved)} case{moved === 1 ? "" : "s"} across {moves.length} title{moves.length === 1 ? "" : "s"} would change category or bucket.
              </p>
              <div className="max-h-72 overflow-auto rounded-md border border-line">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th className="r">Cases</th>
                      <th>From</th>
                      <th>To</th>
                    </tr>
                  </thead>
                  <tbody>
                    {moves.slice(0, 200).map((m, i) => (
                      <tr key={i}>
                        <td className="max-w-80 truncate" title={m.title}>
                          {m.title}
                        </td>
                        <td className="r num">{fmtInt(m.count)}</td>
                        <td className="text-[12.5px]">
                          {m.from} <span className="font-mono text-muted">{m.fromRule}</span>
                        </td>
                        <td className="text-[12.5px]">
                          {m.to} <span className="font-mono text-muted">{m.toRule}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="text-[13px] text-good">No category movements on the latest period's titles.</p>
          )}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <Label htmlFor="pub-label">Version label</Label>
            <Input id="pub-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} className="mt-1 w-full" />
          </div>
          <div>
            <Label htmlFor="pub-notes">Release notes</Label>
            <Input id="pub-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} className="mt-1 w-full" />
          </div>
        </div>
      </div>
    </Dialog>
  );
}
