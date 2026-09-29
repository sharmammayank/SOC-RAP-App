import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { RunWorkspace } from "@/lib/useRun";
import type { DerivedCase, Priority, TsField } from "@/engine/types";
import { ALL_PRIORITIES, METRICS, TS_FIELDS } from "@/engine/types";
import { fmtInTz, tzAbbrev, zonedToUtc } from "@/engine/tz";
import { Button, CsvButton, Dialog, Input, Panel, PrioDot, Select, StatusChip, cx } from "@/components/ui";
import { fmtInt, fmtSecs } from "@/lib/format";
import { toast } from "sonner";

const PAGE = 50;
type SortKey = "created" | "id" | "title" | "priority" | "category";

export function CasesView({ ws, canEdit, initialFilter }: { ws: RunWorkspace; canEdit: boolean; initialFilter?: { status?: string } }) {
  const { ctx, out } = ws;
  const [q, setQ] = useState("");
  const [bucket, setBucket] = useState("");
  const [prio, setPrio] = useState("");
  const [status, setStatus] = useState(initialFilter?.status ?? "");
  const [scope, setScope] = useState<"included" | "excluded" | "all">("included");
  const [sort, setSort] = useState<{ k: SortKey; asc: boolean }>({ k: "created", asc: true });
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<DerivedCase | null>(null);
  const tz = ctx?.settings.displayTz ?? "UTC";
  const rows = useMemo(() => {
    if (!out) return [];
    const qq = q.trim().toLowerCase();
    const r = out.derived.filter(
      (d) =>
        (scope === "all" || (scope === "included" ? !d.excluded : d.excluded)) &&
        (!qq || d.title.toLowerCase().includes(qq) || d.caseId.toLowerCase().includes(qq) || d.category.toLowerCase().includes(qq)) &&
        (!bucket || d.bucket === bucket) &&
        (!prio || (d.priority ?? "Invalid") === prio) &&
        (!status || METRICS.some((m) => d.ev[m.k].s === status)),
    );
    const pi = (p: Priority | null) => (p ? ALL_PRIORITIES.indexOf(p) : 9);
    const cmp: Record<SortKey, (a: DerivedCase, b: DerivedCase) => number> = {
      created: (a, b) => (a.ts.createdAt ?? 0) - (b.ts.createdAt ?? 0),
      id: (a, b) => a.caseId.localeCompare(b.caseId, undefined, { numeric: true }),
      title: (a, b) => a.title.localeCompare(b.title),
      priority: (a, b) => pi(a.priority) - pi(b.priority),
      category: (a, b) => a.category.localeCompare(b.category),
    };
    return r.sort((a, b) => (sort.asc ? 1 : -1) * cmp[sort.k](a, b));
  }, [out, q, bucket, prio, status, scope, sort]);
  if (!ctx || !out) return null;
  const buckets = [...new Set(out.derived.map((d) => d.bucket))].sort();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const pg = Math.min(page, pages - 1);
  const th = (k: SortKey, label: string) => (
    <th>
      <button type="button" className="inline-flex items-center gap-1 uppercase" onClick={() => setSort({ k, asc: sort.k === k ? !sort.asc : true })} aria-sort={sort.k === k ? (sort.asc ? "ascending" : "descending") : "none"}>
        {label}
        {sort.k === k && (sort.asc ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </th>
  );
  const csv = () => [
    ["Row", "Case ID", "Title", "Priority", "Category", "Sub-category", "Bucket", "Rule", "Matched", `Created (${tzAbbrev(tz)})`, "Disposition", "Excluded", ...METRICS.flatMap((m) => [`${m.k} s`, `${m.k} status`, `${m.k} note`])],
    ...rows.map((d) => [d.rowNo, d.caseId, d.title, d.priority ?? "Invalid", d.category, d.subcategory, d.bucket, d.ruleId, d.match, fmtInTz(d.ts.createdAt, tz), d.disposition, d.excluded ? d.excludedReason : "", ...METRICS.flatMap((m) => [d.ev[m.k].el ?? null, d.ev[m.k].s, d.ev[m.k].why ?? ""])]),
  ];
  return (
    <Panel
      title="Cases"
      sub={`${fmtInt(rows.length)} matching · times in ${tz} (${tzAbbrev(tz)})`}
      actions={<CsvButton rows={csv} name={`cases_${ctx.period.start}`} />}
      pad={false}
    >
      <div className="flex flex-wrap gap-2 border-b border-line px-4 py-3">
        <Input type="search" placeholder="Search title, ID or category" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} className="w-64" aria-label="Search cases" />
        <Select aria-label="Report bucket" value={bucket} onChange={(e) => { setBucket(e.target.value); setPage(0); }}>
          <option value="">All buckets</option>
          {buckets.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </Select>
        <Select aria-label="Priority" value={prio} onChange={(e) => { setPrio(e.target.value); setPage(0); }}>
          <option value="">All priorities</option>
          {[...ALL_PRIORITIES, "Invalid"].map((p) => (
            <option key={p}>{p}</option>
          ))}
        </Select>
        <Select aria-label="SLA status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
          <option value="">Any SLA status</option>
          <option value="NOT_MET">Any metric not met</option>
          <option value="PENDING">Any metric pending</option>
          <option value="ERROR">Any data error</option>
          <option value="NA">Any N/A</option>
        </Select>
        <Select aria-label="Scope" value={scope} onChange={(e) => { setScope(e.target.value as typeof scope); setPage(0); }}>
          <option value="included">In this run</option>
          <option value="excluded">Excluded</option>
          <option value="all">All rows</option>
        </Select>
      </div>
      <div className="max-h-[70vh] overflow-auto">
        <table className="tbl">
          <thead>
            <tr>
              {th("id", "Case ID")}
              {th("created", "Created")}
              {th("title", "Title")}
              {th("priority", "Priority")}
              {th("category", "Category · bucket")}
              <th>Rule</th>
              {METRICS.map((m) => (
                <th key={m.k}>{m.k}</th>
              ))}
              <th>Disposition</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(pg * PAGE, pg * PAGE + PAGE).map((d) => (
              <tr key={d.rowNo} className={cx(d.excluded && "opacity-60")}>
                <td className="font-mono text-[12px]">
                  <button type="button" className="text-accent hover:underline" onClick={() => setDetail(d)}>
                    {d.caseId || `row ${d.rowNo}`}
                  </button>
                </td>
                <td className="num whitespace-nowrap text-[12.5px]">{fmtInTz(d.ts.createdAt, tz)}</td>
                <td className="max-w-[360px] min-w-[220px]">{d.title}</td>
                <td className="whitespace-nowrap">
                  <PrioDot p={d.priority} />
                  {d.priority ?? <span className="text-bad">Invalid</span>}
                </td>
                <td>
                  <div>{d.category}</div>
                  <div className="text-[12px] text-muted">{d.bucket}</div>
                </td>
                <td>
                  <div className="font-mono text-[11.5px]">{d.ruleId}</div>
                  {d.match && <div className="font-mono text-[11px] text-muted">“{d.match}”</div>}
                </td>
                {METRICS.map((m) => (
                  <td key={m.k}>
                    <StatusChip s={d.ev[m.k].s} why={d.ev[m.k].why ?? (d.ev[m.k].el != null ? `Elapsed ${fmtSecs(d.ev[m.k].el)}` : undefined)} />
                  </td>
                ))}
                <td className="text-[12.5px]">{d.disposition}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2 text-[12.5px]">
        <span className="text-muted">
          {fmtInt(rows.length ? pg * PAGE + 1 : 0)}–{fmtInt(Math.min(rows.length, pg * PAGE + PAGE))} of {fmtInt(rows.length)}
        </span>
        <div className="flex gap-1">
          <Button size="sm" disabled={pg === 0} onClick={() => setPage(pg - 1)}>
            Previous
          </Button>
          <Button size="sm" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>
            Next
          </Button>
        </div>
      </div>
      {detail && <CaseDetail d={out.derived.find((x) => x.rowNo === detail.rowNo) ?? detail} ws={ws} tz={tz} canEdit={canEdit} onClose={() => setDetail(null)} />}
    </Panel>
  );
}

const TS_LABEL: Record<TsField, string> = { createdAt: "Created", assignedAt: "Acknowledged", investigatedTill: "Investigation end", containmentAt: "Contained", closedAt: "Closed" };

function CaseDetail({ d, ws, tz, canEdit, onClose }: { d: DerivedCase; ws: RunWorkspace; tz: string; canEdit: boolean; onClose: () => void }) {
  const raw = ws.ctx!.raw.get(d.rowNo);
  const c = ws.ctx!.cases.find((x) => x.rowNo === d.rowNo);
  const edits = ws.ctx!.editRows.filter((e) => e.row_no === d.rowNo || (e.kind === "category" && e.target_key === d.norm));
  const [p, setP] = useState<Priority>(d.priority ?? "Medium");
  const [field, setField] = useState<TsField>("assignedAt");
  const [val, setVal] = useState("");
  const [reason, setReason] = useState("");
  const saveTs = () => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(val);
    if (!m) return toast.error("Enter a date and time.");
    const ms = zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], 0, 0, tz);
    ws.apply([{ edit: { kind: "timestamp", rowNo: d.rowNo, field, value: ms }, caseId: d.caseId, old: d.ts[field], reason: reason || "Corrected in case detail" }], "Timestamp saved");
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Case ${d.caseId || "row " + d.rowNo}`} description={d.title} wide>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1 text-[13px]">
          <div className="eyebrow">Classification</div>
          <div>
            {d.category} · {d.subcategory} · bucket <b>{d.bucket}</b>
          </div>
          <div className="font-mono text-[12px] text-muted">
            {d.ruleId}
            {d.match ? ` matched “${d.match}”` : ""}
          </div>
          <div className="eyebrow pt-2">Priority</div>
          <div>
            <PrioDot p={d.priority} />
            {d.priority ?? "Invalid"} {c && <span className="text-muted">(score {String(c.score ?? "blank")}, label {c.label ?? "blank"})</span>}
          </div>
          {d.prioNote && <div className="text-[12px] text-warn">{d.prioNote}</div>}
          {d.excluded && <div className="text-[12.5px] text-warn">Excluded: {d.excludedReason}</div>}
          <div className="eyebrow pt-2">Timestamps ({tzAbbrev(tz)})</div>
          <table className="text-[12.5px]">
            <tbody>
              {TS_FIELDS.map((k) => (
                <tr key={k}>
                  <td className="pr-3 text-muted">{TS_LABEL[k]}</td>
                  <td className="num">{d.ts[k] != null && Number.isNaN(d.ts[k]) ? <span className="text-bad">unreadable</span> : fmtInTz(d.ts[k], tz, true)}</td>
                  <td className="pl-3 font-mono text-[11px] text-muted">{String(c?.raw[k] ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="space-y-2 text-[13px]">
          <div className="eyebrow">SLA evaluation</div>
          {METRICS.map((m) => (
            <div key={m.k} className="flex items-center justify-between gap-2 border-b border-line pb-1">
              <span>
                {m.k} · {m.short}
              </span>
              <span className="flex items-center gap-2">
                <span className="num text-[12px] text-muted">{d.ev[m.k].el != null ? fmtSecs(d.ev[m.k].el) : ""}</span>
                <StatusChip s={d.ev[m.k].s} why={d.ev[m.k].why} />
              </span>
            </div>
          ))}
          {edits.length > 0 && (
            <>
              <div className="eyebrow pt-2">Edits</div>
              <ul className="space-y-1 text-[12px]">
                {edits.map((e) => (
                  <li key={e.id}>
                    <span className="text-muted">{new Date(e.created_at).toLocaleString()}</span> · {e.kind} {e.field ?? ""}: {JSON.stringify(e.old_value)} → {JSON.stringify(e.new_value)} {e.reason && `(${e.reason})`}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
      {canEdit && (
        <div className="mt-4 space-y-2 border-t border-line pt-3">
          <div className="eyebrow">Edit (logged with the original value)</div>
          <div className="flex flex-wrap items-end gap-2">
            <Select aria-label="Priority" value={p} onChange={(e) => setP(e.target.value as Priority)}>
              {ALL_PRIORITIES.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </Select>
            <Button size="sm" disabled={!!ws.busy || p === d.priority} onClick={() => ws.apply([{ edit: { kind: "priority", rowNo: d.rowNo, value: p }, caseId: d.caseId, old: d.priority, reason: reason || "Set in case detail" }], "Priority saved")}>
              Set priority
            </Button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Select aria-label="Timestamp field" value={field} onChange={(e) => setField(e.target.value as TsField)}>
              {TS_FIELDS.map((k) => (
                <option key={k} value={k}>
                  {TS_LABEL[k]}
                </option>
              ))}
            </Select>
            <Input type="datetime-local" value={val} onChange={(e) => setVal(e.target.value)} aria-label="New value" />
            <Button size="sm" disabled={!!ws.busy} onClick={saveTs}>
              Save time
            </Button>
          </div>
          <Input placeholder="Reason (optional, recorded)" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      )}
      {raw && (
        <details className="mt-4 text-[12px]">
          <summary className="cursor-pointer text-accent">Original row {d.rowNo} as uploaded</summary>
          <table className="mt-2">
            <tbody>
              {Object.entries(raw)
                .filter(([k]) => k !== "__row")
                .map(([k, v]) => (
                  <tr key={k}>
                    <td className="pr-3 align-top text-muted">{k}</td>
                    <td className="font-mono break-all">{v == null ? "" : String(v)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </details>
      )}
    </Dialog>
  );
}
