import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileSpreadsheet, UploadCloud } from "lucide-react";
import { useSession } from "@/lib/session";
import { supabase, must } from "@/lib/supabase";
import { parseFileInWorker } from "@/lib/parseFile";
import { createRun, findRunsByHash, stageRun } from "@/lib/runService";
import type { ParsedUpload } from "@/engine/ingest";
import { FIELDS, autoMap, missingRequired, type ColumnMap } from "@/engine/mapping";
import { parseTs } from "@/engine/timestamps";
import { periodError, periodFor, periodLabel, type Cadence, type Period, mondayOf } from "@/engine/periods";
import { fmtInTz, tzAbbrev, ymdOf } from "@/engine/tz";
import { Button, Callout, Chip, Dialog, Empty, Input, Label, PageHeader, Panel, Progress, Segmented, Select, cx } from "@/components/ui";
import { StepRail } from "@/components/RunBits";
import { fmtBytes, fmtInt } from "@/lib/format";
import { MONTH_FULL } from "@/engine/periods";

export default function NewRunPage() {
  const { client, can } = useSession();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState<0 | 1>(0);
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedUpload | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [reading, setReading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cadence, setCadence] = useState<Cadence>((client?.default_cadence as Cadence) ?? "monthly");
  const [period, setPeriod] = useState<Period>(() => periodFor("monthly", new Date().toISOString().slice(0, 10)));
  const [map, setMap] = useState<ColumnMap>({});
  const [conf, setConf] = useState<Record<string, number>>({});
  const [saveProfile, setSaveProfile] = useState(true);
  const [dupes, setDupes] = useState<Awaited<ReturnType<typeof findRunsByHash>>>([]);
  const [dupeOpen, setDupeOpen] = useState(false);
  const [supersedes, setSupersedes] = useState<string | null>(null);
  const [staging, setStaging] = useState<{ pct: number; label: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tz = client?.period_tz ?? "UTC";

  const profileQ = useQuery({
    queryKey: ["column-profile", client?.id],
    enabled: !!client,
    queryFn: async () => must(await supabase.from("column_profiles").select("*").eq("client_id", client!.id).maybeSingle()) as { mapping: ColumnMap } | null,
  });

  const sheet = parsed?.sheets[sheetIdx];

  // Suggest the period from the data: the month (or week) holding the most cases.
  const suggestPeriod = (p: ParsedUpload, idx: number, m: ColumnMap, cad: Cadence): Period | null => {
    const col = m.createdAt;
    if (!col) return null;
    const cnt = new Map<string, number>();
    for (const r of p.sheets[idx].rows) {
      const t = parseTs(r[col], tz).ms;
      if (t == null || Number.isNaN(t)) continue;
      const d = ymdOf(t, tz);
      const k = cad === "weekly" ? mondayOf(d) : d.slice(0, 7) + "-01";
      cnt.set(k, (cnt.get(k) ?? 0) + 1);
    }
    const best = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0];
    return best ? periodFor(cad === "custom" ? "monthly" : cad, best[0]) : null;
  };

  const onFile = async (f: File | undefined) => {
    if (!f || !client) return;
    setErr(null);
    setReading(true);
    setFile(f);
    setParsed(null);
    try {
      const p = await parseFileInWorker(f);
      setParsed(p);
      setSheetIdx(p.sheetIdx);
      const s = autoMap(p.sheets[p.sheetIdx].headers, p.sheets[p.sheetIdx].rows, profileQ.data?.mapping);
      setMap(s.map);
      setConf(s.confidence);
      const sp = suggestPeriod(p, p.sheetIdx, s.map, cadence);
      if (sp) setPeriod(sp);
      const d = await findRunsByHash(client.id, p.sha256);
      setDupes(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setFile(null);
    } finally {
      setReading(false);
    }
  };

  const pickSheet = (i: number) => {
    if (!parsed) return;
    setSheetIdx(i);
    const s = autoMap(parsed.sheets[i].headers, parsed.sheets[i].rows, profileQ.data?.mapping);
    setMap(s.map);
    setConf(s.confidence);
  };

  const changeCadence = (c: Cadence) => {
    setCadence(c);
    if (c === "custom") setPeriod({ ...period, cadence: "custom" });
    else setPeriod(periodFor(c, period.start));
  };

  const perr = periodError({ ...period, cadence });
  const missing = missingRequired(map);
  const inWindow = useMemo(() => {
    if (!sheet || !map.createdAt) return null;
    let inside = 0,
      outside = 0,
      bad = 0;
    for (const r of sheet.rows) {
      const t = parseTs(r[map.createdAt], tz).ms;
      if (t == null || Number.isNaN(t)) bad++;
      else {
        const d = ymdOf(t, tz);
        if (d >= period.start && d <= period.end) inside++;
        else outside++;
      }
    }
    return { inside, outside, bad };
  }, [sheet, map.createdAt, period, tz]);

  const next = () => {
    const samePeriod = dupes.filter((d) => d.period_start === period.start && d.period_end === period.end);
    if (samePeriod.length && supersedes === null) {
      setDupeOpen(true);
      return;
    }
    setStep(1);
  };

  const stage = async () => {
    if (!client || !parsed || !sheet || !file) return;
    setStaging({ pct: 2, label: "Storing the original file…" });
    try {
      const run = await createRun({ client, period: { ...period, cadence }, file, sha256: parsed.sha256, supersedes: supersedes || null });
      setStaging({ pct: 10, label: "Staging rows…" });
      await stageRun(run, client, { sheet: sheet.name, headerRow: sheet.headerRow, rows: sheet.rows, map, saveProfile, headers: sheet.headers }, (d, t) =>
        setStaging({ pct: 10 + (d / t) * 85, label: `Staging rows… ${fmtInt(d)} of ${fmtInt(t)}` }),
      );
      qc.invalidateQueries({ queryKey: ["run-overview"] });
      qc.invalidateQueries({ queryKey: ["column-profile", client.id] });
      nav(`/runs/${run.id}?auto=1`);
    } catch (e) {
      setStaging(null);
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  if (!client) return null;
  if (!can("own"))
    return (
      <Empty title="Only reporting owners can start a run">
        You have {can("review") ? "reviewer" : "read-only"} access to {client.name}. Ask an owner or administrator to upload the period's data.
      </Empty>
    );

  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader eyebrow="New run" title={`Upload period data · ${client.name}`} sub="Weekly or monthly case export. The file is read in your browser first; nothing is stored until you confirm the columns." />
      <StepRail current={step} done={step} onPick={(i) => i === 0 && !staging && setStep(0)} />

      {step === 0 && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <Panel title="1. Upload the case export">
            <div
              className={cx("flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-line-strong bg-surface-2 px-6 py-10 text-center transition", reading && "opacity-60")}
              onDragOver={(e) => {
                e.preventDefault();
                e.currentTarget.classList.add("border-accent");
              }}
              onDragLeave={(e) => e.currentTarget.classList.remove("border-accent")}
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.classList.remove("border-accent");
                onFile(e.dataTransfer.files[0]);
              }}
            >
              <UploadCloud className="size-9 text-muted" aria-hidden />
              <b>Drop the .xlsx or .csv export here</b>
              <span className="text-[12.5px] text-muted">Up to 100 MB or 500,000 rows. Macro workbooks, legacy .xls and unsafe files are refused.</span>
              <Button variant="primary" loading={reading} onClick={() => inputRef.current?.click()}>
                Choose file
              </Button>
              <input ref={inputRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} aria-label="Choose a file to upload" />
            </div>
            {err && (
              <div className="mt-3">
                <Callout tone="bad" title="File not loaded.">
                  {err}
                </Callout>
              </div>
            )}
            {parsed && sheet && (
              <div className="mt-4">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px]">
                  <FileSpreadsheet className="size-4 text-accent" />
                  <b>{parsed.name}</b>
                  <span className="text-muted">{fmtBytes(parsed.size)}</span>
                  <span className="font-mono text-[11.5px] text-muted" title={parsed.sha256}>
                    SHA-256 {parsed.sha256.slice(0, 16)}…
                  </span>
                  {parsed.sheets.length > 1 && (
                    <Select aria-label="Sheet" value={sheetIdx} onChange={(e) => pickSheet(Number(e.target.value))} className="h-8">
                      {parsed.sheets.map((s, i) => (
                        <option key={i} value={i}>
                          {s.name} ({fmtInt(s.rows.length)} rows)
                        </option>
                      ))}
                    </Select>
                  )}
                </div>
                <div className="max-h-[360px] overflow-auto rounded-md border border-line">
                  <table className="tbl text-[12px]">
                    <thead>
                      <tr>
                        <th>Row</th>
                        {sheet.headers.map((h) => (
                          <th key={h} className="whitespace-nowrap normal-case">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sheet.rows.slice(0, 20).map((r, i) => (
                        <tr key={i}>
                          <td className="num text-muted">{String(r.__row ?? i + 2)}</td>
                          {sheet.headers.map((h) => (
                            <td key={h} className="max-w-60 truncate whitespace-nowrap">
                              {r[h] == null ? "" : String(r[h]).slice(0, 120)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1 text-[12px] text-muted">First 20 of {fmtInt(sheet.rows.length)} rows · header found on row {sheet.headerRow}.</p>
              </div>
            )}
          </Panel>
          <Panel title="Reporting period">
            <div className="flex flex-col gap-4">
              <div>
                <div className="eyebrow mb-1.5">Cadence</div>
                <Segmented label="Cadence" value={cadence} onChange={changeCadence} options={[{ v: "weekly", label: "Weekly" }, { v: "monthly", label: "Monthly" }, { v: "custom", label: "Custom" }]} />
              </div>
              {cadence === "monthly" && (
                <div>
                  <Label htmlFor="month">Month</Label>
                  <Input id="month" type="month" value={period.start.slice(0, 7)} onChange={(e) => e.target.value && setPeriod(periodFor("monthly", e.target.value + "-01"))} className="mt-1 w-full" />
                </div>
              )}
              {cadence === "weekly" && (
                <div>
                  <Label htmlFor="week" hint="Weeks run Monday to Sunday.">Week containing</Label>
                  <Input id="week" type="date" value={period.start} onChange={(e) => e.target.value && setPeriod(periodFor("weekly", e.target.value))} className="mt-1 w-full" />
                </div>
              )}
              {cadence === "custom" && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label htmlFor="from">From</Label>
                    <Input id="from" type="date" value={period.start} onChange={(e) => e.target.value && setPeriod({ ...period, start: e.target.value })} className="mt-1 w-full" />
                  </div>
                  <div>
                    <Label htmlFor="to">To</Label>
                    <Input id="to" type="date" value={period.end} onChange={(e) => e.target.value && setPeriod({ ...period, end: e.target.value })} className="mt-1 w-full" />
                  </div>
                </div>
              )}
              <div className="rounded-md bg-surface-2 px-3 py-2 text-[13px]">
                <b>{periodLabel({ ...period, cadence })}</b>
                <div className="text-[12px] text-muted">
                  {period.start} to {period.end}, counted in {tz} ({tzAbbrev(tz)})
                </div>
              </div>
              {perr && <p className="text-[12.5px] text-bad">{perr}</p>}
              {inWindow && (
                <p className="text-[12.5px] text-ink-2">
                  <b className="num">{fmtInt(inWindow.inside)}</b> cases fall in this period.
                  {inWindow.outside > 0 && <> {fmtInt(inWindow.outside)} fall outside it and will be flagged for review, not dropped.</>}
                  {inWindow.bad > 0 && <> {fmtInt(inWindow.bad)} have no readable created time.</>}
                </p>
              )}
              {dupes.length > 0 && (
                <Callout tone="warn" title="This exact file was uploaded before.">
                  {dupes.map((d) => `${periodLabel({ start: d.period_start, end: d.period_end, cadence: "custom" })} (${d.status})`).join(", ")}
                </Callout>
              )}
              <Button variant="primary" disabled={!parsed || !!perr || reading} onClick={next}>
                Next: map columns
              </Button>
            </div>
          </Panel>
        </div>
      )}

      {step === 1 && parsed && sheet && (
        <Panel
          title="2. Map columns"
          sub="Matches were detected automatically. Correct any that are wrong. Required fields must be mapped."
          actions={
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={saveProfile} onChange={(e) => setSaveProfile(e.target.checked)} /> Save as {client.name}'s column profile
            </label>
          }
        >
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Column in your file</th>
                  <th>Match</th>
                  <th>First value</th>
                  <th>Reads as ({tzAbbrev(client.display_tz)})</th>
                </tr>
              </thead>
              <tbody>
                {FIELDS.map((f) => {
                  const col = map[f.k];
                  const first = col ? sheet.rows.find((r) => r[col] != null && r[col] !== "")?.[col] : null;
                  const isTs = ["createdAt", "assignedAt", "investigatedTill", "containmentAt", "closedAt"].includes(f.k);
                  const p = isTs && first != null ? parseTs(first, tz) : null;
                  const c = conf[f.k];
                  return (
                    <tr key={f.k}>
                      <td>
                        <div className="font-medium">
                          {f.label} {f.req && <Chip tone={col ? "neutral" : "bad"}>required</Chip>}
                        </div>
                        {f.help && <div className="text-[12px] text-muted">{f.help}</div>}
                      </td>
                      <td>
                        <Select
                          aria-label={`Column for ${f.label}`}
                          value={col ?? ""}
                          onChange={(e) => {
                            setMap({ ...map, [f.k]: e.target.value || undefined });
                            setConf({ ...conf, [f.k]: e.target.value ? 1 : 0 });
                          }}
                          className="w-56"
                        >
                          <option value="">— not in file —</option>
                          {sheet.headers.map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td>{col ? c >= 1 ? <Chip tone="good">Exact</Chip> : c >= 0.7 ? <Chip tone="info">Synonym</Chip> : <Chip tone="warn">Check</Chip> : <span className="text-[12px] text-muted">—</span>}</td>
                      <td className="max-w-56 truncate font-mono text-[12px]">{first == null ? "" : String(first).slice(0, 60)}</td>
                      <td className="text-[12.5px]">
                        {p ? (
                          Number.isNaN(p.ms) ? (
                            <span className="text-bad">Unreadable</span>
                          ) : (
                            <span>
                              {fmtInTz(p.ms, client.display_tz)} <span className="text-muted">({p.form})</span>
                            </span>
                          )
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {missing.length > 0 && <p className="mt-3 text-[13px] text-bad">Map these required fields first: {missing.join(", ")}.</p>}
          {!map.priorityScore && !map.priorityLabel && <p className="mt-2 text-[13px] text-warn">No priority column is mapped. Every case would be flagged as having an invalid priority.</p>}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button onClick={() => setStep(0)} disabled={!!staging}>
              Back
            </Button>
            <Button variant="primary" disabled={missing.length > 0 || !!staging} loading={!!staging} onClick={stage}>
              Stage {fmtInt(sheet.rows.length)} rows and classify
            </Button>
            {staging && (
              <div className="min-w-72 flex-1">
                <Progress value={staging.pct} label={staging.label} />
              </div>
            )}
          </div>
        </Panel>
      )}

      <Dialog
        open={dupeOpen}
        onOpenChange={setDupeOpen}
        title="This file was already uploaded for this period"
        description={`${MONTH_FULL[Number(period.start.slice(5, 7)) - 1] ?? ""} ${period.start.slice(0, 4)}: the same file hash exists in an earlier run.`}
        footer={
          <>
            <Button onClick={() => setDupeOpen(false)}>Cancel</Button>
            <Button
              onClick={() => {
                setSupersedes("");
                setDupeOpen(false);
                setStep(1);
              }}
            >
              Create a comparison run
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setSupersedes(dupes.find((d) => d.period_start === period.start)?.id ?? "");
                setDupeOpen(false);
                setStep(1);
              }}
            >
              Supersede the earlier run
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-2">
          Superseding replaces the earlier run's results once this one is published. A comparison run keeps both, for example to test new rules or thresholds on the same data.
        </p>
      </Dialog>
    </div>
  );
}
