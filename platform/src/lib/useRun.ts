import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase, fetchAll } from "./supabase";
import type { CaseEditRow } from "./db";
import { adoptLatestVersions, compute, loadRunContext, recalcAndPersist, recordEdits, rowToEdit, type RunContext } from "./runService";
import type { RunOutput } from "@/engine/run";
import type { Edit } from "@/engine/types";

export interface RunWorkspace {
  ctx: RunContext | null;
  out: RunOutput | null;
  loading: string | null;
  error: unknown;
  busy: string | null;
  /** Records review decisions, pulls in anyone else's, re-evaluates and saves (spec AT-08). */
  apply: (items: { edit: Edit; caseId?: string; old?: unknown; reason?: string }[], okMsg?: string) => Promise<boolean>;
  recalc: (msg?: string) => Promise<void>;
  adoptLatest: () => Promise<void>;
  reload: () => Promise<void>;
  setCtx: (c: RunContext) => void;
  editable: boolean;
}

export function useRun(runId: string | undefined, opts: { autoClassify?: boolean } = {}): RunWorkspace {
  const [ctx, setCtxState] = useState<RunContext | null>(null);
  const [out, setOut] = useState<RunOutput | null>(null);
  const [loading, setLoading] = useState<string | null>("Loading run…");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(Promise.resolve());
  const ctxRef = useRef<RunContext | null>(null);
  const qc = useQueryClient();
  const setCtx = (c: RunContext) => {
    ctxRef.current = c;
    setCtxState({ ...c });
  };

  const serial = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const p = lock.current.then(fn, fn);
    lock.current = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }, []);

  const load = useCallback(async () => {
    if (!runId) return;
    setError(null);
    setLoading("Loading run…");
    try {
      const c = await loadRunContext(runId, (m) => setLoading(m));
      setCtx(c);
      if (c.run.status === "staged" || (opts.autoClassify && c.run.status === "draft")) {
        setLoading("Classifying and validating…");
        const o = await recalcAndPersist(c, (m) => setLoading(m));
        setCtx(c);
        setOut(o);
        qc.invalidateQueries({ queryKey: ["run-overview"] });
      } else setOut(compute(c));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(null);
    }
  }, [runId, opts.autoClassify, qc]);

  useEffect(() => {
    load();
  }, [load]);

  const editable = !!ctx && (ctx.run.status === "review" || ctx.run.status === "staged");

  const recalc = useCallback(
    (msg = "Recalculating…") =>
      serial(async () => {
        const c = ctxRef.current;
        if (!c) return;
        setBusy(msg);
        try {
          const o = await recalcAndPersist(c, setBusy);
          setCtx(c);
          setOut(o);
          qc.invalidateQueries({ queryKey: ["run-overview"] });
        } catch (e) {
          toast.error(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(null);
        }
      }),
    [serial, qc],
  );

  const apply = useCallback(
    (items: { edit: Edit; caseId?: string; old?: unknown; reason?: string }[], okMsg?: string) =>
      serial(async () => {
        const c = ctxRef.current;
        if (!c) return false;
        setBusy("Saving…");
        try {
          await recordEdits(c, items);
          // Merge decisions other reviewers made meanwhile, in log order.
          const rows = await fetchAll<CaseEditRow>((f, t) => supabase.from("case_edits").select("*").eq("run_id", c.run.id).order("id").range(f, t));
          c.editRows = rows;
          c.edits = rows.map(rowToEdit).filter((x): x is Edit => !!x);
          const o = await recalcAndPersist(c, setBusy);
          setCtx(c);
          setOut(o);
          qc.invalidateQueries({ queryKey: ["run-overview"] });
          if (okMsg) toast.success(okMsg);
          return true;
        } catch (e) {
          toast.error(e instanceof Error ? e.message : String(e));
          return false;
        } finally {
          setBusy(null);
        }
      }),
    [serial, qc],
  );

  const adoptLatest = useCallback(
    () =>
      serial(async () => {
        const c = ctxRef.current;
        if (!c) return;
        setBusy("Applying the latest versions…");
        try {
          await adoptLatestVersions(c);
          const o = await recalcAndPersist(c, setBusy);
          setCtx(c);
          setOut(o);
          toast.success(`Now using SLA v${c.threshold.version_no} and rules v${c.ruleset.version_no}`);
        } catch (e) {
          toast.error(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(null);
        }
      }),
    [serial],
  );

  return { ctx, out, loading, error, busy, apply, recalc, adoptLatest, reload: load, setCtx, editable };
}
