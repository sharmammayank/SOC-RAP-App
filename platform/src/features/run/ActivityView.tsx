import { useQuery } from "@tanstack/react-query";
import type { RunWorkspace } from "@/lib/useRun";
import { supabase, must } from "@/lib/supabase";
import type { AuditRow } from "@/lib/db";
import { actorNames } from "@/lib/report";
import { CsvButton, Panel } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

const show = (v: unknown) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));

export function ActivityView({ ws }: { ws: RunWorkspace }) {
  const ctx = ws.ctx!;
  const names = useQuery({ queryKey: ["actor-names"], queryFn: actorNames });
  const audit = useQuery({
    queryKey: ["run-audit", ctx.run.id, ctx.run.status],
    queryFn: async () => must(await supabase.from("audit_log").select("*").eq("entity", "run").eq("entity_id", ctx.run.id).order("created_at", { ascending: false })) as AuditRow[],
  });
  const who = (id: string | null) => (id && names.data?.get(id)) || id || "system";
  const edits = [...ctx.editRows].reverse();
  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Edit log"
        sub="Every review decision with the original value, the new value, who made it and when. The uploaded rows are never changed."
        actions={<CsvButton name={`edits_${ctx.period.start}`} rows={() => [["When", "Who", "Action", "Case", "Row", "Field", "Original", "New", "Reason"], ...edits.map((e) => [e.created_at, who(e.actor), e.kind, e.case_id, e.row_no, e.field ?? e.target_key, show(e.old_value), show(e.new_value), e.reason])]} />}
        pad={false}
      >
        {edits.length ? (
          <div className="max-h-[60vh] overflow-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Case / target</th>
                  <th>Original → new</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {edits.map((e) => (
                  <tr key={e.id}>
                    <td className="text-[12.5px] whitespace-nowrap">{fmtDateTime(e.created_at)}</td>
                    <td className="text-[12.5px]">{who(e.actor)}</td>
                    <td>
                      {e.kind}
                      {e.field ? ` · ${e.field}` : ""}
                    </td>
                    <td className="max-w-72 truncate text-[12.5px]" title={e.target_key ?? ""}>
                      {e.case_id ?? (e.row_no != null ? `row ${e.row_no}` : e.target_key)}
                    </td>
                    <td className="font-mono text-[11.5px]">
                      {show(e.old_value)} → {show(e.new_value)}
                    </td>
                    <td className="text-[12.5px]">{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="p-4 text-[13px] text-muted">No edits yet.</p>
        )}
      </Panel>
      <Panel title="Run history" pad={false}>
        <table className="tbl">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Event</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {(audit.data ?? []).map((a) => (
              <tr key={a.id}>
                <td className="text-[12.5px] whitespace-nowrap">{fmtDateTime(a.created_at)}</td>
                <td className="text-[12.5px]">{who(a.actor)}</td>
                <td>{a.action}</td>
                <td className="font-mono text-[11.5px]">{JSON.stringify(a.detail)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
