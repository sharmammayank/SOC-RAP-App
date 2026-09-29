import { useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Mail, Plus } from "lucide-react";
import { useSession } from "@/lib/session";
import { supabase, must } from "@/lib/supabase";
import type { AuditRow, Client, ClientRole, Member, Profile, Run, RulesetVersion, ThresholdVersion } from "@/lib/db";
import { Button, Callout, Chip, CsvButton, Dialog, Empty, Input, Label, PageHeader, Panel, Select, Spinner, cx } from "@/components/ui";
import { MembersPanel, ROLE_LABEL } from "./ClientSettingsPage";
import { fmtDate, fmtDateTime, fmtInt } from "@/lib/format";
import { periodLabel } from "@/engine/periods";

const TABS = [
  ["clients", "Clients"],
  ["users", "Users & roles"],
  ["audit", "Audit log"],
  ["versions", "Reference data"],
  ["retention", "Retention"],
] as const;

export default function AdminPage() {
  const { isAdmin } = useSession();
  if (!isAdmin) return <Empty title="Administrators only">Ask an administrator for access.</Empty>;
  return (
    <div className="mx-auto max-w-[1300px]">
      <PageHeader eyebrow="Administration" title="Administration" sub="Clients, users and roles, the audit log, reference-data versions and retention." />
      <div role="tablist" className="mb-4 flex flex-wrap gap-1 border-b border-line">
        {TABS.map(([k, l]) => (
          <NavLink key={k} to={`/admin/${k}`} className={({ isActive }) => cx("-mb-px border-b-2 px-3 py-2 text-[13.5px] font-medium", isActive ? "border-accent text-accent" : "border-transparent text-ink-2 hover:text-ink")}>
            {l}
          </NavLink>
        ))}
      </div>
      <Routes>
        <Route index element={<Navigate to="clients" replace />} />
        <Route path="clients" element={<Clients />} />
        <Route path="users" element={<Users />} />
        <Route path="audit" element={<Audit />} />
        <Route path="versions" element={<Versions />} />
        <Route path="retention" element={<Retention />} />
      </Routes>
    </div>
  );
}

function Clients() {
  const qc = useQueryClient();
  const { refresh, setClientId } = useSession();
  const q = useQuery({ queryKey: ["admin-clients"], queryFn: async () => must(await supabase.from("clients").select("*").order("name")) as Client[] });
  const [name, setName] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const create = async () => {
    const n = name.trim();
    if (!n) return;
    const { data, error } = await supabase.from("clients").insert({ name: n }).select("*").single();
    if (error) return toast.error(error.code === "23505" ? "A client with that name already exists." : error.message);
    setName("");
    await refresh();
    qc.invalidateQueries({ queryKey: ["admin-clients"] });
    setClientId((data as Client).id);
    toast.success(`${n} created with the baseline SLA thresholds and the seed rule set. You're its owner.`);
  };
  const archive = async (c: Client) => {
    const { error } = await supabase.from("clients").update({ archived_at: c.archived_at ? null : new Date().toISOString() }).eq("id", c.id);
    if (error) return toast.error(error.message);
    await refresh();
    qc.invalidateQueries({ queryKey: ["admin-clients"] });
  };
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Create a client">
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor="new-client">Client name</Label>
            <Input id="new-client" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} className="mt-1 w-72" />
          </div>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={create} disabled={!name.trim()}>
            Create client
          </Button>
        </div>
        <p className="mt-2 text-[12.5px] text-muted">New clients start from SLA baseline SEP-2026-SLA-01 and a copy of the global rule set. Clone another client's configuration from its SLA or Rules page.</p>
      </Panel>
      <Panel title="Clients" pad={false}>
        {q.isLoading ? (
          <Spinner />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Time zones</th>
                <th>Cadence</th>
                <th>Created</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(q.data ?? []).map((c) => (
                <tr key={c.id}>
                  <td className="font-medium">{c.name}</td>
                  <td className="text-[12.5px]">
                    {c.period_tz} / {c.display_tz}
                  </td>
                  <td>{c.default_cadence}</td>
                  <td className="text-[12.5px]">{fmtDate(c.created_at)}</td>
                  <td>{c.archived_at ? <Chip>Archived</Chip> : <Chip tone="good">Active</Chip>}</td>
                  <td className="r whitespace-nowrap">
                    <Button size="sm" variant="ghost" onClick={() => setSel(c.id)}>
                      Members
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => archive(c)}>
                      {c.archived_at ? "Restore" : "Archive"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {sel && (
        <Dialog open onOpenChange={(o) => !o && setSel(null)} title={`Members · ${q.data?.find((c) => c.id === sel)?.name}`} wide>
          <MembersPanel clientId={sel} canManage />
        </Dialog>
      )}
    </div>
  );
}

function Users() {
  const qc = useQueryClient();
  const { session, clients } = useSession();
  const q = useQuery({
    queryKey: ["admin-users"],
    queryFn: async () => {
      const [p, m] = await Promise.all([supabase.from("profiles").select("*").order("email"), supabase.from("client_members").select("*")]);
      return { profiles: must(p) as Profile[], members: must(m) as Member[] };
    },
  });
  const [inv, setInv] = useState({ email: "", name: "", client: "", role: "reviewer" as ClientRole, admin: false });
  const [busy, setBusy] = useState(false);
  const cname = (id: string) => clients.find((c) => c.id === id)?.name ?? id.slice(0, 8);
  const invite = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-invite", { body: { email: inv.email.trim(), full_name: inv.name.trim(), client_id: inv.client || null, role: inv.role, is_admin: inv.admin, redirect_to: window.location.origin } });
      if (error) throw new Error((data as { error?: string })?.error ?? error.message);
      toast.success(`Invitation sent to ${inv.email.trim()}`);
      setInv({ ...inv, email: "", name: "" });
      qc.invalidateQueries({ queryKey: ["admin-users"] });
    } catch (e) {
      toast.error((e instanceof Error ? e.message : String(e)) + ". If the invite function isn't deployed, invite from Supabase → Authentication → Users instead.");
    } finally {
      setBusy(false);
    }
  };
  const toggleAdmin = async (p: Profile) => {
    const { error } = await supabase.from("profiles").update({ is_admin: !p.is_admin }).eq("id", p.id);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["admin-users"] });
  };
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Invite a user" sub="Sends a Supabase invitation email. With Microsoft Entra ID sign-in enabled, people can also sign in directly and be added to clients afterwards.">
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor="inv-email">Email</Label>
            <Input id="inv-email" type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} className="mt-1 w-64" />
          </div>
          <div>
            <Label htmlFor="inv-name">Name</Label>
            <Input id="inv-name" value={inv.name} onChange={(e) => setInv({ ...inv, name: e.target.value })} className="mt-1 w-48" />
          </div>
          <div>
            <Label htmlFor="inv-client">Client (optional)</Label>
            <Select id="inv-client" value={inv.client} onChange={(e) => setInv({ ...inv, client: e.target.value })} className="mt-1">
              <option value="">—</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="inv-role">Role</Label>
            <Select id="inv-role" value={inv.role} disabled={!inv.client} onChange={(e) => setInv({ ...inv, role: e.target.value as ClientRole })} className="mt-1">
              {(Object.keys(ROLE_LABEL) as ClientRole[]).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
          </div>
          <label className="flex h-9 items-center gap-1.5 text-[13px]">
            <input type="checkbox" checked={inv.admin} onChange={(e) => setInv({ ...inv, admin: e.target.checked })} /> Administrator
          </label>
          <Button variant="primary" icon={<Mail className="size-4" />} loading={busy} disabled={!/^\S+@\S+\.\S+$/.test(inv.email)} onClick={invite}>
            Send invite
          </Button>
        </div>
      </Panel>
      <Panel title="Users" pad={false}>
        {q.isLoading ? (
          <Spinner />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>User</th>
                <th>Access</th>
                <th>Joined</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(q.data?.profiles ?? []).map((p) => {
                const ms = q.data!.members.filter((m) => m.user_id === p.id);
                return (
                  <tr key={p.id}>
                    <td>
                      <div>{p.full_name || p.email}</div>
                      <div className="text-[12px] text-muted">{p.email}</div>
                    </td>
                    <td className="text-[12.5px]">
                      {p.is_admin && <Chip tone="info">Administrator</Chip>} {ms.map((m) => `${cname(m.client_id)}: ${ROLE_LABEL[m.role]}`).join(" · ") || (!p.is_admin && <span className="text-muted">No clients</span>)}
                    </td>
                    <td className="text-[12.5px]">{fmtDate(p.created_at)}</td>
                    <td className="r">
                      {p.id !== session?.user.id && (
                        <Button size="sm" variant="ghost" onClick={() => toggleAdmin(p)}>
                          {p.is_admin ? "Remove admin" : "Make admin"}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

function Audit() {
  const { clients } = useSession();
  const [client, setClient] = useState("");
  const [action, setAction] = useState("");
  const [limit, setLimit] = useState(200);
  const q = useQuery({
    queryKey: ["audit", client, action, limit],
    queryFn: async () => {
      let s = supabase.from("audit_log").select("*").order("created_at", { ascending: false }).limit(limit);
      if (client) s = s.eq("client_id", client);
      if (action) s = s.ilike("action", `%${action}%`);
      return must(await s) as AuditRow[];
    },
  });
  const names = useQuery({ queryKey: ["admin-users"], queryFn: async () => ({ profiles: must(await supabase.from("profiles").select("*")) as Profile[], members: [] as Member[] }) });
  const who = (id: string | null) => names.data?.profiles.find((p) => p.id === id)?.email ?? id ?? "system";
  const cname = (id: string | null) => (id ? clients.find((c) => c.id === id)?.name ?? id.slice(0, 8) : "—");
  return (
    <Panel
      title="Audit log"
      sub="Runs, publishing, purges, versions, memberships and admin changes. Case-level edits are in each run's Activity tab."
      actions={<CsvButton name="audit_log" rows={() => [["When", "Who", "Client", "Action", "Entity", "Entity ID", "Detail"], ...(q.data ?? []).map((a) => [a.created_at, who(a.actor), cname(a.client_id), a.action, a.entity, a.entity_id, JSON.stringify(a.detail)])]} />}
      pad={false}
    >
      <div className="flex flex-wrap gap-2 border-b border-line px-4 py-3">
        <Select aria-label="Client" value={client} onChange={(e) => setClient(e.target.value)}>
          <option value="">All clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Input placeholder="Action contains…" value={action} onChange={(e) => setAction(e.target.value)} className="w-56" aria-label="Filter by action" />
        <Select aria-label="Rows" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
          {[200, 1000, 5000].map((n) => (
            <option key={n} value={n}>
              Latest {fmtInt(n)}
            </option>
          ))}
        </Select>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : (
        <div className="max-h-[70vh] overflow-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Client</th>
                <th>Action</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {(q.data ?? []).map((a) => (
                <tr key={a.id}>
                  <td className="text-[12.5px] whitespace-nowrap">{fmtDateTime(a.created_at)}</td>
                  <td className="text-[12.5px]">{who(a.actor)}</td>
                  <td className="text-[12.5px]">{cname(a.client_id)}</td>
                  <td>{a.action}</td>
                  <td className="max-w-[480px] font-mono text-[11.5px] break-all">{JSON.stringify(a.detail)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function Versions() {
  const { clients } = useSession();
  const q = useQuery({
    queryKey: ["admin-versions"],
    queryFn: async () => {
      const [t, r, runs] = await Promise.all([
        supabase.from("threshold_versions").select("id,client_id,version_no,label,effective_from,created_at,notes").order("created_at", { ascending: false }),
        supabase.from("ruleset_versions").select("id,client_id,version_no,label,status,effective_from,published_at,created_at,notes,rules").order("created_at", { ascending: false }),
        supabase.from("runs").select("id,threshold_version_id,ruleset_version_id"),
      ]);
      return { t: must(t) as ThresholdVersion[], r: must(r) as RulesetVersion[], runs: must(runs) as Pick<Run, "id" | "threshold_version_id" | "ruleset_version_id">[] };
    },
  });
  if (q.isLoading || !q.data) return <Spinner />;
  const cname = (id: string | null) => (id ? clients.find((c) => c.id === id)?.name ?? "—" : "Global baseline");
  const uses = (k: "threshold_version_id" | "ruleset_version_id", id: string) => q.data.runs.filter((r) => r[k] === id).length;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="SLA threshold versions" pad={false}>
        <div className="max-h-[70vh] overflow-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Client</th>
                <th>Version</th>
                <th>Effective</th>
                <th className="r">Runs</th>
              </tr>
            </thead>
            <tbody>
              {q.data.t.map((v) => (
                <tr key={v.id}>
                  <td>{cname(v.client_id)}</td>
                  <td>
                    v{v.version_no} · {v.label}
                  </td>
                  <td className="text-[12.5px]">{fmtDate(v.effective_from)}</td>
                  <td className="r num">{uses("threshold_version_id", v.id)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="Rule-set versions" pad={false}>
        <div className="max-h-[70vh] overflow-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Client</th>
                <th>Version</th>
                <th>Status</th>
                <th className="r">Rules</th>
                <th className="r">Runs</th>
              </tr>
            </thead>
            <tbody>
              {q.data.r.map((v) => (
                <tr key={v.id}>
                  <td>{cname(v.client_id)}</td>
                  <td>
                    {v.version_no ? `v${v.version_no} · ` : ""}
                    {v.label}
                  </td>
                  <td>{v.status === "published" ? <Chip tone="good">Published {fmtDate(v.published_at)}</Chip> : <Chip tone="warn">Draft</Chip>}</td>
                  <td className="r num">{v.rules.length}</td>
                  <td className="r num">{uses("ruleset_version_id", v.id)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function Retention() {
  const qc = useQueryClient();
  const { clients } = useSession();
  const [months, setMonths] = useState(13);
  const q = useQuery({ queryKey: ["retention", months], queryFn: async () => must(await supabase.rpc("runs_past_retention", { p_months: months })) as Run[] });
  const [target, setTarget] = useState<Run | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const purge = async () => {
    if (!target) return;
    setBusy(true);
    try {
      // Stored files first, through the Storage API; then the run and all its rows (logged).
      for (const bucket of ["uploads", "artifacts"]) {
        const prefix = `${target.client_id}/${target.id}`;
        const { data } = await supabase.storage.from(bucket).list(prefix, { limit: 1000 });
        if (data?.length) {
          const { error } = await supabase.storage.from(bucket).remove(data.map((o) => `${prefix}/${o.name}`));
          if (error) throw new Error(error.message);
        }
      }
      must(await supabase.rpc("purge_run", { p_run: target.id, p_reason: reason }));
      toast.success("Run purged and logged");
      setTarget(null);
      setReason("");
      qc.invalidateQueries();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <Callout>
        Policy (spec §8.5): raw uploads are kept 13 months and derived results 3 years. Purging removes a run's file, raw rows, results and edits, and is always logged with a reason. It can't be undone.
      </Callout>
      <Panel
        title="Runs older than the retention window"
        actions={
          <Select aria-label="Months" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
            {[13, 24, 36].map((m) => (
              <option key={m} value={m}>
                Older than {m} months
              </option>
            ))}
          </Select>
        }
        pad={false}
      >
        {q.isLoading ? (
          <Spinner />
        ) : !q.data?.length ? (
          <p className="p-4 text-[13px] text-muted">Nothing is past the window.</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Client</th>
                <th>Period</th>
                <th>Status</th>
                <th>Created</th>
                <th className="r">Rows</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.map((r) => (
                <tr key={r.id}>
                  <td>{clients.find((c) => c.id === r.client_id)?.name ?? r.client_id.slice(0, 8)}</td>
                  <td>{periodLabel({ start: r.period_start, end: r.period_end, cadence: r.cadence })}</td>
                  <td>{r.status}</td>
                  <td>{fmtDate(r.created_at)}</td>
                  <td className="r num">{fmtInt(r.row_count)}</td>
                  <td className="r">
                    <Button size="sm" variant="danger" onClick={() => setTarget(r)}>
                      Purge
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {target && (
        <Dialog
          open
          onOpenChange={(o) => !o && setTarget(null)}
          title="Purge this run permanently?"
          description={`${periodLabel({ start: target.period_start, end: target.period_end, cadence: target.cadence })} · ${fmtInt(target.row_count)} rows`}
          footer={
            <>
              <Button onClick={() => setTarget(null)}>Cancel</Button>
              <Button variant="danger" loading={busy} disabled={reason.trim().length < 5} onClick={purge}>
                Purge permanently
              </Button>
            </>
          }
        >
          <Label htmlFor="purge-reason">Reason (recorded in the audit log)</Label>
          <Input id="purge-reason" value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 w-full" placeholder="Retention policy: older than 13 months" />
        </Dialog>
      )}
    </div>
  );
}
