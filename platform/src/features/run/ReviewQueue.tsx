import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, ListChecks, Wand2 } from "lucide-react";
import type { RunWorkspace } from "@/lib/useRun";
import type { DerivedCase, Edit, Issue, Metric, Priority, TsField } from "@/engine/types";
import { ALL_PRIORITIES } from "@/engine/types";
import { ISSUE_LABEL, ISSUE_ORDER, reduceEdits } from "@/engine/run";
import { checkPattern, exactTitlePattern, normTitle, suggestPattern } from "@/engine/rules";
import { fmtInTz, tzAbbrev, zonedToUtc } from "@/engine/tz";
import { promoteToDraft } from "@/lib/rulesService";
import { Button, Callout, Chip, Input, Segmented, Select, cx, Panel } from "@/components/ui";
import { fmtInt } from "@/lib/format";

const TS_LABEL: Record<TsField, string> = { createdAt: "Created", assignedAt: "Acknowledged", investigatedTill: "Investigation end", containmentAt: "Contained", closedAt: "Closed" };

export function ReviewQueue({ ws, canEdit, canPromote }: { ws: RunWorkspace; canEdit: boolean; canPromote: boolean }) {
  const { ctx, out } = ws;
  const [sev, setSev] = useState<"all" | "blocking" | "non_blocking">("all");
  const [type, setType] = useState<string>("");
  const [showAccepted, setShowAccepted] = useState(false);
  const st = useMemo(() => reduceEdits(ctx?.edits ?? []), [ctx?.edits, ctx?.editRows.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const byRow = useMemo(() => new Map((out?.derived ?? []).map((d) => [d.rowNo, d])), [out]);
  if (!ctx || !out) return null;
  const tz = ctx.settings.displayTz;
  const accepted = (i: Issue) => st.accepted.has(i.key);
  const issues = out.issues
    .filter((i) => (sev === "all" ? true : sev === "blocking" ? i.blocking : !i.blocking))
    .filter((i) => !type || i.type === type)
    .filter((i) => showAccepted || !accepted(i))
    .sort((a, b) => ISSUE_ORDER[a.type] - ISSUE_ORDER[b.type] || b.rows.length - a.rows.length);
  const counts = new Map<string, { n: number; blocking: boolean; open: number }>();
  for (const i of out.issues) {
    const c = counts.get(i.type) ?? { n: 0, blocking: i.blocking, open: 0 };
    c.n++;
    if (!accepted(i)) c.open++;
    counts.set(i.type, c);
  }
  const categories = [...new Set([...ctx.ruleset.rules.map((r) => r.category), ...[...st.category.values()].map((c) => c.category)])].filter((c) => c && c !== "Uncategorized").sort();
  const buckets = [...new Set(ctx.ruleset.rules.map((r) => r.report_bucket))].filter(Boolean).sort();
  const openUncat = out.issues.filter((i) => i.type === "UNCAT" && !accepted(i));

  const acceptAll = (t: string, reason: string) => {
    const items = out.issues.filter((i) => i.type === t && !i.blocking && !accepted(i)).map((i) => ({ edit: { kind: "accept", key: i.key, reason } as Edit, reason }));
    if (items.length) ws.apply(items, `Accepted ${items.length} ${ISSUE_LABEL[t].toLowerCase()} item${items.length > 1 ? "s" : ""}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <datalist id="cat-list">
        {categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <datalist id="bucket-list">
        {buckets.map((b) => (
          <option key={b} value={b} />
        ))}
      </datalist>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Severity"
          size="sm"
          value={sev}
          onChange={setSev}
          options={[
            { v: "all", label: "All" },
            { v: "blocking", label: `Blocking (${out.counts.blockingOpen})` },
            { v: "non_blocking", label: `To review (${out.counts.nonBlockingOpen})` },
          ]}
        />
        <Select aria-label="Exception type" value={type} onChange={(e) => setType(e.target.value)} className="h-8">
          <option value="">All types</option>
          {[...counts.entries()]
            .sort((a, b) => ISSUE_ORDER[a[0]] - ISSUE_ORDER[b[0]])
            .map(([t, c]) => (
              <option key={t} value={t}>
                {ISSUE_LABEL[t]} ({c.open} open)
              </option>
            ))}
        </Select>
        <label className="flex items-center gap-1.5 text-[13px]">
          <input type="checkbox" checked={showAccepted} onChange={(e) => setShowAccepted(e.target.checked)} /> Show accepted
        </label>
      </div>

      {canEdit && [...counts.entries()].some(([t, c]) => !c.blocking && c.open > 1 && t !== "UNCAT") && (
        <Panel title={<span className="flex items-center gap-2"><ListChecks className="size-4" /> Bulk actions</span>}>
          <div className="flex flex-wrap gap-2">
            {[...counts.entries()]
              .filter(([t, c]) => !c.blocking && c.open > 0 && t !== "UNCAT")
              .map(([t, c]) => (
                <Button key={t} size="sm" onClick={() => acceptAll(t, t === "OUT" ? "Excluded: outside the reporting period" : "Accepted in bulk")} disabled={!!ws.busy}>
                  {t === "OUT" ? "Keep all out-of-period cases excluded" : `Accept all ${c.open} ${ISSUE_LABEL[t].toLowerCase()} items`}
                </Button>
              ))}
          </div>
        </Panel>
      )}

      {canEdit && openUncat.length > 1 && <BulkCategorize ws={ws} issues={openUncat} buckets={buckets} canPromote={canPromote} />}

      {!issues.length ? (
        <Callout tone="good" title={out.issues.length ? "Nothing matches these filters." : "No exceptions."}>
          {out.issues.length ? "Change the filters to see other items." : "Every record in this period can be evaluated as it is."}
        </Callout>
      ) : (
        <div className="flex flex-col gap-2">
          {issues.slice(0, 300).map((i) => (
            <IssueCard key={i.key} i={i} ws={ws} byRow={byRow} tz={tz} accepted={accepted(i)} canEdit={canEdit} canPromote={canPromote} buckets={buckets} />
          ))}
          {issues.length > 300 && <p className="text-[12.5px] text-muted">Showing the first 300 of {fmtInt(issues.length)} items. Use the filters or bulk actions to work through the rest.</p>}
        </div>
      )}
    </div>
  );
}

function BulkCategorize({ ws, issues, buckets, canPromote }: { ws: RunWorkspace; issues: Issue[]; buckets: string[]; canPromote: boolean }) {
  const [cat, setCat] = useState("");
  const [bkt, setBkt] = useState(buckets.includes("Other") ? "Other" : buckets[0] ?? "Other");
  const [promote, setPromote] = useState(false);
  const n = issues.reduce((a, i) => a + i.rows.length, 0);
  const go = async () => {
    if (!cat.trim()) return toast.error("Enter a category.");
    const ok = await ws.apply(
      issues.map((i) => ({ edit: { kind: "category", norm: i.norm!, category: cat.trim(), bucket: bkt } as Edit, reason: "Bulk assignment" })),
      `Categorized ${fmtInt(n)} cases as ${cat.trim()}`,
    );
    if (ok && promote && ws.ctx) {
      for (const i of issues) await promoteToDraft(ws.ctx.client.id, { category: cat.trim(), report_bucket: bkt, subcategory: "Added in review", pattern: exactTitlePattern(i.norm!), precedence: 50, fields: ["title"], enabled: true, sample_titles: [i.title!], notes: `Promoted from run ${ws.ctx.period.start}` });
      toast.success(`${issues.length} rules added to the next rule-set draft`);
    }
  };
  return (
    <Panel title={`Assign all ${issues.length} uncategorized titles (${fmtInt(n)} cases) at once`}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[12.5px]">
          Category
          <Input list="cat-list" value={cat} onChange={(e) => setCat(e.target.value)} placeholder="e.g. M365 Defender" className="w-52" />
        </label>
        <label className="flex flex-col gap-1 text-[12.5px]">
          Report bucket
          <Input list="bucket-list" value={bkt} onChange={(e) => setBkt(e.target.value)} className="w-44" />
        </label>
        {canPromote && (
          <label className="flex h-9 items-center gap-1.5 text-[13px]">
            <input type="checkbox" checked={promote} onChange={(e) => setPromote(e.target.checked)} /> Also add an exact-title rule for each to the next rule-set draft
          </label>
        )}
        <Button variant="primary" onClick={go} loading={!!ws.busy}>
          Apply to all
        </Button>
      </div>
    </Panel>
  );
}

function CaseLine({ d, tz }: { d: DerivedCase | undefined; tz: string }) {
  if (!d) return null;
  return (
    <div className="num text-[12px] text-ink-2">
      <span className="font-mono">{d.caseId || "(no ID)"}</span> · row {d.rowNo} · {d.title || "(no title)"} · created {fmtInTz(d.ts.createdAt, tz)} · ack {fmtInTz(d.ts.assignedAt, tz)} · closed {fmtInTz(d.ts.closedAt, tz)} {tzAbbrev(tz)}
    </div>
  );
}

function toLocalInput(ms: number | null | undefined, tz: string) {
  if (ms == null || Number.isNaN(ms)) return "";
  return fmtInTz(ms, tz).replace(" ", "T");
}
function fromLocalInput(v: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  return m ? zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], 0, 0, tz) : null;
}

function IssueCard({ i, ws, byRow, tz, accepted, canEdit, canPromote, buckets }: { i: Issue; ws: RunWorkspace; byRow: Map<number, DerivedCase>; tz: string; accepted: boolean; canEdit: boolean; canPromote: boolean; buckets: string[] }) {
  const [open, setOpen] = useState(i.blocking && !accepted);
  const [reason, setReason] = useState("");
  const d = byRow.get(i.rows[0]);
  const busy = !!ws.busy;
  const count = i.rows.length;
  const title = (() => {
    switch (i.type) {
      case "UNCAT":
        return `No rule matches “${i.title}” (${fmtInt(count)} case${count > 1 ? "s" : ""})`;
      case "AMBIG":
        return `“${i.title}” matched two rules at the same precedence (${fmtInt(count)} case${count > 1 ? "s" : ""})`;
      case "PRIO":
        return `Case ${i.caseId || "row " + i.rows[0]}: the priority is blank or unreadable`;
      case "PFIX":
        return `${fmtInt(count)} case${count > 1 ? "s" : ""}: ${i.note}`;
      case "DUP":
        return `Case ID ${i.caseId} appears ${count} times`;
      case "CHRONO":
        return `Case ${i.caseId}: closed before it was acknowledged`;
      case "NEG":
        return `Case ${i.caseId}: ${TS_LABEL[i.field!]} is earlier than creation`;
      case "TS":
        return `Case ${i.caseId || "row " + i.rows[0]}: ${TS_LABEL[i.field!]} can't be read as a date`;
      case "OUT":
        return i.note!;
      default:
        return i.key;
    }
  })();
  const why: Record<string, string> = {
    UNCAT: "Assign a category to the whole title group, promote a rule, or leave it uncategorized for this run.",
    AMBIG: "Confirm the chosen category, or change precedence in Category Rules for future runs.",
    PRIO: "Blocks publishing: without a priority the case can't be evaluated against any limit.",
    PFIX: "The score wasn't a standard value. Accept the correction or set the priority.",
    DUP: "Blocks publishing: the same case would be counted twice.",
    CHRONO: "Blocks publishing: acknowledgement after closure makes TTA meaningless.",
    NEG: "Blocks publishing: a milestone before creation gives a negative elapsed time.",
    TS: "Blocks publishing: the value isn't a readable date.",
    OUT: "Records outside the declared window are excluded by default, never silently dropped. Include any that belong to this period.",
  };
  const apply = (items: { edit: Edit; caseId?: string; old?: unknown; reason?: string }[], msg: string) => ws.apply(items, msg);

  let body: React.ReactNode = null;
  if (i.type === "UNCAT") body = <UncatBody i={i} ws={ws} canPromote={canPromote} buckets={buckets} accepted={accepted} canEdit={canEdit} />;
  else if (i.type === "AMBIG")
    body = (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] text-ink-2">
          Chosen: <b>{d?.category}</b> via <span className="font-mono">{d?.ruleId}</span>. {i.note}
        </span>
        {canEdit && !accepted && (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => apply([{ edit: { kind: "accept", key: i.key, reason: "Category confirmed" }, reason: "Category confirmed" }], "Category confirmed")}>
            Confirm category
          </Button>
        )}
      </div>
    );
  else if (i.type === "PRIO" || i.type === "PFIX") body = <PrioBody i={i} ws={ws} canEdit={canEdit} accepted={accepted} byRow={byRow} />;
  else if (i.type === "DUP")
    body = (
      <div className="flex flex-col gap-2">
        {i.rows.map((r) => (
          <div key={r} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface-2 px-3 py-2">
            <CaseLine d={byRow.get(r)} tz={tz} />
            {canEdit && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  apply(
                    i.rows.filter((x) => x !== r).map((x) => ({ edit: { kind: "drop", rowNo: x, reason: reason || `Duplicate of row ${r}` } as Edit, caseId: i.caseId, reason: reason || `Duplicate of row ${r}` })),
                    `Kept row ${r} of case ${i.caseId}`,
                  )
                }
              >
                Keep this row, drop the others
              </Button>
            )}
          </div>
        ))}
        {canEdit && <Input placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} className="max-w-md" />}
      </div>
    );
  else if (i.type === "CHRONO" || i.type === "NEG" || i.type === "TS") body = <TsBody i={i} ws={ws} d={d} tz={tz} canEdit={canEdit} />;
  else if (i.type === "OUT") body = <OutBody i={i} ws={ws} byRow={byRow} tz={tz} canEdit={canEdit} accepted={accepted} />;

  return (
    <div className={cx("overflow-hidden rounded-lg border bg-surface", accepted ? "border-line opacity-75" : i.blocking ? "border-bad/40" : "border-line")}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2">
        <span aria-hidden className={cx("h-8 w-1 shrink-0 rounded-full", i.blocking ? "bg-bad" : accepted ? "bg-line-strong" : "bg-warn")} />
        {open ? <ChevronDown className="size-4 shrink-0 text-muted" /> : <ChevronRight className="size-4 shrink-0 text-muted" />}
        {i.blocking ? <Chip tone="bad">Blocks publishing</Chip> : accepted ? <Chip>Accepted</Chip> : <Chip tone="warn">Review</Chip>}
        <Chip>{ISSUE_LABEL[i.type]}</Chip>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{title}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-line px-4 py-3">
          <p className="text-[12.5px] text-muted">{why[i.type]}</p>
          {i.type !== "DUP" && i.type !== "OUT" && i.type !== "UNCAT" && i.type !== "PFIX" && <CaseLine d={d} tz={tz} />}
          {body}
        </div>
      )}
    </div>
  );
}

function UncatBody({ i, ws, canPromote, buckets, accepted, canEdit }: { i: Issue; ws: RunWorkspace; canPromote: boolean; buckets: string[]; accepted: boolean; canEdit: boolean }) {
  const [cat, setCat] = useState("");
  const [bkt, setBkt] = useState(buckets.includes("Other") ? "Other" : buckets[0] ?? "Other");
  const [promote, setPromote] = useState(canPromote);
  const [pattern, setPattern] = useState(suggestPattern(i.norm!) || exactTitlePattern(i.norm!));
  const [err, setErr] = useState<string | null>(null);
  const ctx = ws.ctx!;
  const out = ws.out!;
  // Similar titles (token overlap) as a suggestion only; never auto-applied (spec §4.3.5).
  const suggestion = useMemo(() => {
    const toks = new Set(i.norm!.split(" ").filter((t) => t.length > 3));
    if (!toks.size) return null;
    let best: { cat: string; score: number; title: string } | null = null;
    const seen = new Set<string>();
    for (const d of out.derived) {
      if (d.category === "Uncategorized" || seen.has(d.norm)) continue;
      seen.add(d.norm);
      const t2 = d.norm.split(" ");
      const common = t2.filter((t) => toks.has(t)).length;
      const score = common / Math.max(toks.size, t2.length);
      if (score > 0.34 && (!best || score > best.score)) best = { cat: d.category, score, title: d.title };
    }
    return best;
  }, [i.norm, out.derived]);
  const ids = i.rows.slice(0, 6).map((r) => out.derived.find((d) => d.rowNo === r)?.caseId).filter(Boolean);
  const go = async () => {
    setErr(null);
    if (!cat.trim()) return setErr("Enter a category.");
    if (promote) {
      const e = checkPattern(pattern);
      if (e) return setErr(e);
      if (!new RegExp(pattern).test(normTitle(i.title))) return setErr("The pattern doesn't match this title. Adjust it or untick “Promote to rule”.");
    }
    const ok = await ws.apply([{ edit: { kind: "category", norm: i.norm!, category: cat.trim(), bucket: bkt.trim() || "Other" }, reason: "Assigned in review" }], `Categorized ${fmtInt(i.rows.length)} case${i.rows.length > 1 ? "s" : ""} as ${cat.trim()}`);
    if (ok && promote) {
      try {
        const { rule } = await promoteToDraft(ctx.client.id, { category: cat.trim(), report_bucket: bkt.trim() || "Other", subcategory: "Added in review", pattern, precedence: 50, fields: ["title"], enabled: true, sample_titles: [i.title!], notes: `Promoted from the ${ctx.period.start} run` });
        toast.success(`${rule.rule_id} added to the next rule-set draft. Publish it from Category rules.`);
      } catch (e) {
        toast.error("The category was applied, but the rule couldn't be saved: " + (e instanceof Error ? e.message : String(e)));
      }
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[12px] text-muted">
        Case IDs: {ids.join(", ")}
        {i.rows.length > 6 ? "…" : ""} · normalized: <span className="font-mono">{i.norm}</span>
      </div>
      {suggestion && (
        <div className="text-[12.5px] text-ink-2">
          <Wand2 className="mr-1 inline size-3.5 text-accent" />
          Similar to “{suggestion.title}” ({suggestion.cat}).{" "}
          {canEdit && !accepted && (
            <button type="button" className="text-accent underline" onClick={() => setCat(suggestion.cat)}>
              Use {suggestion.cat}
            </button>
          )}
        </div>
      )}
      {canEdit && !accepted && (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-[12.5px]">
              Category
              <Input list="cat-list" value={cat} onChange={(e) => setCat(e.target.value)} placeholder="e.g. ServiceNow" className="w-48" />
            </label>
            <label className="flex flex-col gap-1 text-[12.5px]">
              Report bucket
              <Input list="bucket-list" value={bkt} onChange={(e) => setBkt(e.target.value)} className="w-40" />
            </label>
            {canPromote && (
              <label className="flex h-9 items-center gap-1.5 text-[13px]">
                <input type="checkbox" checked={promote} onChange={(e) => setPromote(e.target.checked)} /> Promote to rule
              </label>
            )}
            {promote && <Input aria-label="Rule pattern" value={pattern} onChange={(e) => setPattern(e.target.value)} className="min-w-64 flex-1 font-mono text-[12.5px]" />}
          </div>
          {err && <p className="text-[12.5px] text-bad">{err}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={go} disabled={!!ws.busy}>
              Apply to {fmtInt(i.rows.length)} case{i.rows.length > 1 ? "s" : ""}
            </Button>
            <Button size="sm" disabled={!!ws.busy} onClick={() => ws.apply([{ edit: { kind: "accept", key: i.key, reason: "Intentionally uncategorized for this run" }, reason: "Intentionally uncategorized for this run" }], "Left uncategorized")}>
              Leave uncategorized
            </Button>
          </div>
          {promote && <p className="text-[12px] text-muted">The rule goes into the next rule-set draft. This run keeps its recorded rule-set version; the category above is applied as a manual assignment.</p>}
        </>
      )}
    </div>
  );
}

function PrioBody({ i, ws, canEdit, accepted, byRow }: { i: Issue; ws: RunWorkspace; canEdit: boolean; accepted: boolean; byRow: Map<number, DerivedCase> }) {
  const [p, setP] = useState<Priority>("Medium");
  const ctx = ws.ctx!;
  const c = ctx.cases.find((x) => x.rowNo === i.rows[0]);
  if (!canEdit) return null;
  const setAll = () =>
    ws.apply(
      i.rows.map((r) => ({ edit: { kind: "priority", rowNo: r, value: p } as Edit, caseId: byRow.get(r)?.caseId, old: byRow.get(r)?.priority ?? null, reason: i.type === "PFIX" ? i.note : "Priority corrected" })),
      `Set ${fmtInt(i.rows.length)} case${i.rows.length > 1 ? "s" : ""} to ${p}`,
    );
  return (
    <div className="flex flex-col gap-2">
      {i.type === "PRIO" && (
        <div className="text-[12.5px] text-ink-2">
          Value in file: score <b>{String(c?.score ?? "blank")}</b>, label <b>{c?.label ?? "blank"}</b>
        </div>
      )}
      {i.type === "PFIX" && (
        <div className="text-[12px] text-muted">
          Case IDs: {i.rows.slice(0, 8).map((r) => byRow.get(r)?.caseId).join(", ")}
          {i.rows.length > 8 ? "…" : ""}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {i.type === "PFIX" && !accepted && (
          <Button size="sm" variant="primary" disabled={!!ws.busy} onClick={() => ws.apply([{ edit: { kind: "accept", key: i.key, reason: i.note }, reason: i.note }], "Correction accepted")}>
            Accept the correction
          </Button>
        )}
        <span className="text-[13px]">{i.type === "PFIX" ? "or set all to" : "Set priority"}</span>
        <Select aria-label="Priority" value={p} onChange={(e) => setP(e.target.value as Priority)} className="h-8">
          {ALL_PRIORITIES.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </Select>
        <Button size="sm" variant={i.type === "PRIO" ? "primary" : "secondary"} disabled={!!ws.busy} onClick={setAll}>
          Save
        </Button>
      </div>
    </div>
  );
}

function TsBody({ i, ws, d, tz, canEdit }: { i: Issue; ws: RunWorkspace; d: DerivedCase | undefined; tz: string; canEdit: boolean }) {
  const field = i.field ?? "assignedAt";
  const metric: Metric | undefined = i.metric;
  const [val, setVal] = useState(toLocalInput(d?.ts[field], tz));
  const [reason, setReason] = useState("");
  const c = ws.ctx!.cases.find((x) => x.rowNo === i.rows[0]);
  if (!canEdit) return null;
  const save = () => {
    const ms = fromLocalInput(val, tz);
    if (ms == null) return toast.error("Enter a date and time.");
    ws.apply([{ edit: { kind: "timestamp", rowNo: i.rows[0], field, value: ms }, caseId: i.caseId, old: d?.ts[field] ?? null, reason: reason || "Timestamp corrected" }], `${TS_LABEL[field]} corrected for case ${i.caseId}`);
  };
  return (
    <div className="flex flex-col gap-2">
      {i.type === "TS" && (
        <div className="text-[12.5px] text-ink-2">
          Value in file: <span className="font-mono">{String(c?.raw[field] ?? "")}</span>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[12.5px]">
          Correct {TS_LABEL[field]} ({tzAbbrev(tz)})
          <Input type="datetime-local" value={val} onChange={(e) => setVal(e.target.value)} />
        </label>
        <Input placeholder="Reason (recorded in the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} className="min-w-64 flex-1" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={!!ws.busy} onClick={save}>
          Save correction
        </Button>
        {metric && (
          <Button
            size="sm"
            disabled={!!ws.busy}
            onClick={() => {
              if (!reason.trim()) return toast.error("Give a reason to mark the metric Not Applicable.");
              ws.apply([{ edit: { kind: "void_metric", rowNo: i.rows[0], metric, reason: reason.trim() }, caseId: i.caseId, reason: reason.trim() }], `${metric} marked N/A for case ${i.caseId}`);
            }}
          >
            Mark {metric} N/A with reason
          </Button>
        )}
        {i.type === "TS" && field !== "createdAt" && (
          <Button size="sm" disabled={!!ws.busy} onClick={() => ws.apply([{ edit: { kind: "timestamp", rowNo: i.rows[0], field, value: null }, caseId: i.caseId, old: String(c?.raw[field] ?? ""), reason: reason || "Unreadable value treated as blank" }], "Treated as blank")}>
            Treat as blank
          </Button>
        )}
        {i.type === "TS" && field === "createdAt" && (
          <Button
            size="sm"
            variant="danger"
            disabled={!!ws.busy}
            onClick={() => {
              if (!reason.trim()) return toast.error("Give a reason to drop the case.");
              ws.apply([{ edit: { kind: "drop", rowNo: i.rows[0], reason: reason.trim() }, caseId: i.caseId, reason: reason.trim() }], "Case dropped");
            }}
          >
            Drop the case with reason
          </Button>
        )}
      </div>
    </div>
  );
}

function OutBody({ i, ws, byRow, tz, canEdit, accepted }: { i: Issue; ws: RunWorkspace; byRow: Map<number, DerivedCase>; tz: string; canEdit: boolean; accepted: boolean }) {
  const st = reduceEdits(ws.ctx!.edits);
  const rows = i.rows.map((r) => byRow.get(r)!).filter(Boolean);
  const byDay = new Map<string, number>();
  for (const d of rows) {
    const k = fmtInTz(d.ts.createdAt, ws.ctx!.settings.periodTz).slice(0, 10);
    byDay.set(k, (byDay.get(k) ?? 0) + 1);
  }
  const included = rows.filter((d) => st.period.get(d.rowNo) === true).length;
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[12.5px] text-ink-2">
        By created date:{" "}
        {[...byDay.entries()]
          .sort()
          .slice(0, 12)
          .map(([k, n]) => `${k} (${n})`)
          .join(", ")}
        {byDay.size > 12 ? "…" : ""}. {included ? `${included} included in this run.` : "All excluded."}
      </div>
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!!ws.busy} onClick={() => ws.apply(rows.filter((d) => st.period.get(d.rowNo) !== true).map((d) => ({ edit: { kind: "period", rowNo: d.rowNo, include: true } as Edit, caseId: d.caseId, reason: "Included in this period" })), "Included in this run")}>
            Include all {fmtInt(rows.length)} in this run
          </Button>
          {included > 0 && (
            <Button size="sm" disabled={!!ws.busy} onClick={() => ws.apply(rows.filter((d) => st.period.get(d.rowNo) === true).map((d) => ({ edit: { kind: "period", rowNo: d.rowNo, include: false } as Edit, caseId: d.caseId, reason: "Excluded from this period" })), "Excluded again")}>
              Exclude them again
            </Button>
          )}
          {!accepted && (
            <Button size="sm" variant="primary" disabled={!!ws.busy} onClick={() => ws.apply([{ edit: { kind: "accept", key: i.key, reason: "Excluded: outside the reporting period" }, reason: "Excluded: outside the reporting period" }], "Confirmed")}>
              Confirm the exclusion
            </Button>
          )}
        </div>
      )}
      <details className="text-[12.5px]">
        <summary className="cursor-pointer text-accent">Show cases</summary>
        <div className="mt-2 flex flex-col gap-1">
          {rows.slice(0, 50).map((d) => (
            <div key={d.rowNo} className="flex items-center justify-between gap-2">
              <CaseLine d={d} tz={tz} />
              {canEdit && (
                <Button size="sm" variant="ghost" disabled={!!ws.busy} onClick={() => ws.apply([{ edit: { kind: "period", rowNo: d.rowNo, include: st.period.get(d.rowNo) !== true }, caseId: d.caseId, reason: "Period decision" }])}>
                  {st.period.get(d.rowNo) === true ? "Exclude" : "Include"}
                </Button>
              )}
            </div>
          ))}
          {rows.length > 50 && <span className="text-muted">…and {rows.length - 50} more.</span>}
        </div>
      </details>
    </div>
  );
}
