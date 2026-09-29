import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useSession } from "@/lib/session";
import { supabase } from "@/lib/supabase";
import { Button, Callout, Input, Label, PageHeader, Panel } from "@/components/ui";
import { ROLE_LABEL } from "./ClientSettingsPage";

export default function AccountPage() {
  const { profile, session, memberships, clients, isAdmin, refresh } = useSession();
  const [sp] = useSearchParams();
  const [name, setName] = useState(profile?.full_name ?? "");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  useEffect(() => setName(profile?.full_name ?? ""), [profile]);
  const saveName = async () => {
    const { error } = await supabase.from("profiles").update({ full_name: name.trim().slice(0, 120) }).eq("id", session!.user.id);
    if (error) return toast.error(error.message);
    await refresh();
    toast.success("Name saved");
  };
  const savePw = async () => {
    if (pw.length < 12) return toast.error("Use at least 12 characters.");
    if (pw !== pw2) return toast.error("The passwords don't match.");
    const { error } = await supabase.auth.updateUser({ password: pw });
    if (error) return toast.error(error.message);
    setPw("");
    setPw2("");
    toast.success("Password changed");
  };
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader eyebrow="Account" title={profile?.full_name || session?.user.email || "Account"} sub={session?.user.email} />
      {sp.get("reset") && (
        <div className="mb-4">
          <Callout tone="info">Set a new password below.</Callout>
        </div>
      )}
      <div className="flex flex-col gap-4">
        <Panel title="Profile">
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label htmlFor="acc-name">Display name</Label>
              <Input id="acc-name" value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-72" maxLength={120} />
            </div>
            <Button onClick={saveName}>Save</Button>
          </div>
        </Panel>
        <Panel title="Access">
          <ul className="text-[13px]">
            {isAdmin && <li>Administrator (all clients)</li>}
            {memberships.map((m) => (
              <li key={m.client_id}>
                {clients.find((c) => c.id === m.client_id)?.name ?? m.client_id}: {ROLE_LABEL[m.role]}
              </li>
            ))}
            {!isAdmin && !memberships.length && <li className="text-muted">No client access yet.</li>}
          </ul>
        </Panel>
        {session?.user.app_metadata?.provider === "email" && (
          <Panel title="Password">
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <Label htmlFor="pw1">New password</Label>
                <Input id="pw1" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} className="mt-1 w-56" />
              </div>
              <div>
                <Label htmlFor="pw2">Repeat</Label>
                <Input id="pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} className="mt-1 w-56" />
              </div>
              <Button onClick={savePw}>Change password</Button>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
