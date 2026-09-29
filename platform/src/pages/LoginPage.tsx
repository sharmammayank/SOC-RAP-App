import { useState } from "react";
import { toast } from "sonner";
import { supabase, azureEnabled } from "@/lib/supabase";
import { Button, Callout, Input, Label, Segmented } from "@/components/ui";

type Mode = "password" | "link" | "reset";

export function LoginPage() {
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const redirectTo = window.location.origin;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (mode === "password") {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      } else if (mode === "link") {
        const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: redirectTo, shouldCreateUser: false } });
        if (error) throw error;
        setSent(`We sent a sign-in link to ${email.trim()}. It works once and expires in an hour.`);
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: redirectTo + "/account?reset=1" });
        if (error) throw error;
        setSent(`If ${email.trim()} has an account, a password reset link is on its way.`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  const microsoft = async () => {
    const { error } = await supabase.auth.signInWithOAuth({ provider: "azure", options: { scopes: "email openid profile", redirectTo } });
    if (error) toast.error(error.message);
  };

  return (
    <main className="grid min-h-screen place-items-center bg-bg px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-10" />
          <div>
            <div className="font-head text-[20px] font-semibold">SOC-RAP</div>
            <div className="text-[12.5px] text-muted">SLA & service review reporting</div>
          </div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-6 shadow-card">
          <h1 className="mb-4 text-[18px]">Sign in</h1>
          {azureEnabled && (
            <>
              <Button variant="primary" className="w-full" onClick={microsoft}>
                Sign in with Microsoft
              </Button>
              <div className="my-4 flex items-center gap-3 text-[12px] text-muted">
                <span className="h-px flex-1 bg-line" />
                or with email
                <span className="h-px flex-1 bg-line" />
              </div>
            </>
          )}
          <div className="mb-4">
            <Segmented label="Sign-in method" size="sm" value={mode} onChange={(m) => { setMode(m); setSent(null); setErr(null); }} options={[{ v: "password", label: "Password" }, { v: "link", label: "Email link" }, { v: "reset", label: "Reset" }]} />
          </div>
          {sent ? (
            <Callout tone="good">{sent}</Callout>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-3">
              <Label htmlFor="email">Work email</Label>
              <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
              {mode === "password" && (
                <>
                  <Label htmlFor="pw">Password</Label>
                  <Input id="pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                </>
              )}
              {err && <p className="text-[12.5px] text-bad" role="alert">{err}</p>}
              <Button type="submit" variant={azureEnabled ? "secondary" : "primary"} loading={busy} className="mt-1">
                {mode === "password" ? "Sign in" : mode === "link" ? "Email me a link" : "Send reset link"}
              </Button>
            </form>
          )}
          <p className="mt-4 text-[12px] text-muted">Accounts are created by an administrator. Ask yours for an invite if you don't have one.</p>
        </div>
      </div>
    </main>
  );
}
