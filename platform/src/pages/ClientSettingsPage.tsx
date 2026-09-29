import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { UserPlus } from "lucide-react";
import { useSession } from "@/lib/session";
import { supabase, must } from "@/lib/supabase";
import type { Client, ClientRole, Member, Profile } from "@/lib/db";
import { isValidTz, tzAbbrev } from "@/engine/tz";
import { DEFAULT_MATERIALITY } from "@/engine/analytics";
import { Button, Callout, Input, Label, PageHeader, Panel, Select, Spinner } from "@/components/ui";

const TZS = ["UTC", "Asia/Kolkata", "Europe/London", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Los_Angeles", "Asia/Singapore", "Australia/Sydney"];
export const ROLE_LABEL: Record<ClientRole, string> = { owner: "Reporting owner", reviewer: "Reviewer", viewer: "Read-only" };

export default function ClientSettingsPage() {
  const { client, can, refresh } = useSession();
  const qc = useQueryClient();
  const [f, setF] = useState<Client | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setF(client ? structuredClone(client) : null), [client]);
  if (!client || !f) return <Spinner />;
  const editable = can("own");
  const s = f.settings ?? {};
  const mat = s.materiality ?? DEFAULT_MATERIALITY;
  const tzOk = isValidTz(f.period_tz) && isValidTz(f.display_tz);
  const save = async () => {
    if (!tzOk) return toast.error("Enter valid IANA time zones, for example Asia/Kolkata.");
    setSaving(true);
    try {
      must(
        await supabase
          .from("clients")
          .update({ name: f.name.trim(), period_tz: f.period_tz, display_tz: f.display_tz, default_cadence: f.default_cadence, source_label: f.source_label.trim(), settings: f.settings })
          .eq("id", client.id),
      );
      await refresh();
      qc.invalidateQueries();
      toast.success("Client settings saved. They apply to new runs; existing runs keep their recorded settings.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const setS = (patch: Partial<Client["settings"]>) => setF({ ...f, settings: { ...s, ...patch } });
  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader eyebrow="Configuration" title={`Client settings · ${client.name}`} sub="Reporting clock, labels and calculation options for this client. Changes apply to runs staged afterwards." />
      {!editable && <div className="mb-4"><Callout>You have read-only access to these settings.</Callout></div>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Profile">
          <fieldset disabled={!editable} className="flex flex-col gap-3">
            <div>
              <Label htmlFor="c-name">Client name</Label>
              <Input id="c-name" value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} className="mt-1 w-full" />
            </div>
            <div>
              <Label htmlFor="c-src" hint="Used in slide titles and observations, e.g. “Google SecOps cases”.">Case source label</Label>
              <Input id="c-src" value={f.source_label} maxLength={80} onChange={(e) => setF({ ...f, source_label: e.target.value })} className="mt-1 w-full" />
            </div>
            <div>
              <Label htmlFor="c-cad">Default cadence</Label>
              <Select id="c-cad" value={f.default_cadence} onChange={(e) => setF({ ...f, default_cadence: e.target.value as Client["default_cadence"] })} className="mt-1 w-full">
                <option value="monthly">Monthly</option>
                <option value="weekly">Weekly</option>
                <option value="custom">Custom</option>
              </Select>
            </div>
          </fieldset>
        </Panel>
        <Panel title="Time zones">
          <fieldset disabled={!editable} className="flex flex-col gap-3">
            <datalist id="tz-list">
              {TZS.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <div>
              <Label htmlFor="c-ptz" hint="Decides which day, week and month a case belongs to. UTC matches most SIEM exports.">Reporting (period) time zone</Label>
              <Input id="c-ptz" list="tz-list" value={f.period_tz} onChange={(e) => setF({ ...f, period_tz: e.target.value })} className="mt-1 w-full" />
            </div>
            <div>
              <Label htmlFor="c-dtz" hint="Used for hour-of-day heatmaps and displayed times (e.g. the analyst shift clock).">Display time zone</Label>
              <Input id="c-dtz" list="tz-list" value={f.display_tz} onChange={(e) => setF({ ...f, display_tz: e.target.value })} className="mt-1 w-full" />
            </div>
            <p className={tzOk ? "text-[12.5px] text-muted" : "text-[12.5px] text-bad"}>{tzOk ? `Periods in ${tzAbbrev(f.period_tz)}, hours in ${tzAbbrev(f.display_tz)}.` : "Unknown time zone name."}</p>
          </fieldset>
        </Panel>
        <Panel title="Calculation options">
          <fieldset disabled={!editable} className="flex flex-col gap-3 text-[13px]">
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={s.ackZero !== false} onChange={(e) => setS({ ackZero: e.target.checked })} />
              <span>
                When a case has no acknowledge time, count TTA as 0 seconds (MET). These cases are left out of average times. <span className="text-muted">This matches the manual workbook.</span>
              </span>
            </label>
            <div>
              <Label htmlFor="c-uw" hint="Raises a run-level warning on the review screen.">Uncategorized warning level (%)</Label>
              <Input id="c-uw" type="number" min="0" max="100" step="0.5" value={s.uncategorizedWarnPct ?? 5} onChange={(e) => setS({ uncategorizedWarnPct: Math.max(0, Math.min(100, Number(e.target.value))) })} className="mt-1 w-32" />
            </div>
          </fieldset>
        </Panel>
        <Panel title="Observation materiality" sub="Minimum change before an observation is generated, so small accounts aren't flooded with noise.">
          <fieldset disabled={!editable} className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="m-abs">Min. cases</Label>
              <Input id="m-abs" type="number" min="0" value={mat.minAbs} onChange={(e) => setS({ materiality: { ...mat, minAbs: Math.max(0, Number(e.target.value)) } })} className="mt-1 w-full" />
            </div>
            <div>
              <Label htmlFor="m-pct">Min. change %</Label>
              <Input id="m-pct" type="number" min="0" value={mat.minPct} onChange={(e) => setS({ materiality: { ...mat, minPct: Math.max(0, Number(e.target.value)) } })} className="mt-1 w-full" />
            </div>
            <div>
              <Label htmlFor="m-conc">Concentration %</Label>
              <Input id="m-conc" type="number" min="0" max="100" value={mat.concentrationPct} onChange={(e) => setS({ materiality: { ...mat, concentrationPct: Math.max(0, Number(e.target.value)) } })} className="mt-1 w-full" />
            </div>
          </fieldset>
        </Panel>
      </div>
      {editable && (
        <div className="mt-4">
          <Button variant="primary" loading={saving} onClick={save}>
            Save settings
          </Button>
        </div>
      )}
      <div className="mt-6">
        <MembersPanel clientId={client.id} canManage={editable} />
      </div>
    </div>
  );
}

export function MembersPanel({ clientId, canManage }: { clientId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const { session } = useSession();
  const q = useQuery({
    queryKey: ["members", clientId],
    queryFn: async () => {
      const [m, p] = await Promise.all([supabase.from("client_members").select("*").eq("client_id", clientId), supabase.from("profiles").select("*").order("email")]);
      return { members: must(m) as Member[], profiles: must(p) as Profile[] };
    },
  });
  const [add, setAdd] = useState({ user: "", role: "reviewer" as ClientRole });
  if (q.isLoading || !q.data) return <Spinner />;
  const byId = new Map(q.data.profiles.map((p) => [p.id, p]));
  const outside = q.data.profiles.filter((p) => !q.data.members.some((m) => m.user_id === p.id));
  const run = async (fn: () => PromiseLike<{ error: { message: string } | null }>, ok: string) => {
    const { error } = await fn();
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["members", clientId] });
    toast.success(ok);
  };
  return (
    <Panel title="Members" sub="Reporting owners run and publish periods and maintain SLA and rules; reviewers resolve exceptions; read-only users see results. Administrators have full access to every client." pad={false}>
      <table className="tbl">
        <thead>
          <tr>
            <th>User</th>
            <th>Role</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {q.data.members.map((m) => {
            const p = byId.get(m.user_id);
            return (
              <tr key={m.user_id}>
                <td>
                  <div>{p?.full_name || p?.email}</div>
                  <div className="text-[12px] text-muted">{p?.email}</div>
                </td>
                <td>
                  <Select aria-label="Role" value={m.role} disabled={!canManage} onChange={(e) => run(() => supabase.from("client_members").update({ role: e.target.value }).eq("client_id", clientId).eq("user_id", m.user_id), "Role updated")}>
                    {(Object.keys(ROLE_LABEL) as ClientRole[]).map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="r">
                  {canManage && m.user_id !== session?.user.id && (
                    <Button size="sm" variant="ghost" onClick={() => run(() => supabase.from("client_members").delete().eq("client_id", clientId).eq("user_id", m.user_id), "Member removed")}>
                      Remove
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {canManage && (
        <div className="flex flex-wrap items-end gap-2 border-t border-line px-4 py-3">
          <Select aria-label="User to add" value={add.user} onChange={(e) => setAdd({ ...add, user: e.target.value })} className="min-w-64">
            <option value="">Add an existing user…</option>
            {outside.map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name ? `${p.full_name} (${p.email})` : p.email}
              </option>
            ))}
          </Select>
          <Select aria-label="Role for new member" value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value as ClientRole })}>
            {(Object.keys(ROLE_LABEL) as ClientRole[]).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="primary" icon={<UserPlus className="size-3.5" />} disabled={!add.user} onClick={() => run(() => supabase.from("client_members").insert({ client_id: clientId, user_id: add.user, role: add.role }), "Member added").then(() => setAdd({ ...add, user: "" }))}>
            Add
          </Button>
          <span className="text-[12px] text-muted">New people must be invited by an administrator first.</span>
        </div>
      )}
    </Panel>
  );
}
