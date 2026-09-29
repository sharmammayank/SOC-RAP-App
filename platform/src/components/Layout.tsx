import { NavLink, useLocation, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import * as DM from "@radix-ui/react-dropdown-menu";
import { BarChart3, FileDown, Gauge, GitCompareArrows, LayoutDashboard, ListFilter, LogOut, Moon, Plus, Settings2, Shield, Sun, Timer, User, Building2, Monitor } from "lucide-react";
import { useSession } from "@/lib/session";
import { Button, Chip, cx, Select } from "./ui";
import { getTheme, setTheme, type ThemePref } from "@/lib/theme";
import { useState } from "react";

const NAV: { to: string; label: string; icon: ReactNode; admin?: boolean }[] = [
  { to: "/", label: "Dashboard", icon: <LayoutDashboard className="size-4" /> },
  { to: "/analytics", label: "Analytics", icon: <BarChart3 className="size-4" /> },
  { to: "/compare", label: "Comparison", icon: <GitCompareArrows className="size-4" /> },
  { to: "/exports", label: "Exports", icon: <FileDown className="size-4" /> },
];
const CONFIG: { to: string; label: string; icon: ReactNode }[] = [
  { to: "/config/sla", label: "SLA configuration", icon: <Timer className="size-4" /> },
  { to: "/config/rules", label: "Category rules", icon: <ListFilter className="size-4" /> },
  { to: "/client", label: "Client settings", icon: <Building2 className="size-4" /> },
];

function Item({ to, label, icon }: { to: string; label: string; icon: ReactNode }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) => cx("flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13.5px] transition", isActive ? "bg-white/12 font-medium text-white" : "text-white/75 hover:bg-white/8 hover:text-white")}
    >
      {icon}
      {label}
    </NavLink>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { clients, clientId, setClientId, role, isAdmin, profile, session, signOut, can } = useSession();
  const nav = useNavigate();
  const { pathname } = useLocation();
  // Administration and account pages work without a client, so the first admin can create one.
  const clientFree = pathname.startsWith("/admin") || pathname.startsWith("/account");
  const [theme, setThemeState] = useState<ThemePref>(getTheme());
  const nextTheme = () => {
    const t: ThemePref = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
    setTheme(t);
    setThemeState(t);
  };
  return (
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col gap-4 bg-[#002855] px-3 py-4 text-white" aria-label="Main navigation">
        <div className="flex items-center gap-2 px-1.5">
          <img src="/favicon.svg" alt="" className="size-7" />
          <div className="leading-tight">
            <div className="font-head text-[16px] font-semibold">SOC-RAP</div>
            <div className="text-[11px] text-white/60">SLA & service review</div>
          </div>
        </div>
        <div className="px-1">
          <label htmlFor="client-switch" className="mb-1 block text-[10.5px] font-semibold tracking-[0.08em] text-white/60 uppercase">
            Client
          </label>
          {clients.length ? (
            <Select id="client-switch" value={clientId ?? ""} onChange={(e) => setClientId(e.target.value)} className="w-full border-white/20 bg-white/10 text-white [&>option]:text-black">
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          ) : (
            <p className="text-[12px] text-white/60">No clients yet.</p>
          )}
          {role && <div className="mt-1.5 text-[11px] text-white/60">Your role: {isAdmin ? "Administrator" : role === "owner" ? "Reporting owner" : role === "reviewer" ? "Reviewer" : "Read-only"}</div>}
        </div>
        {clientId && can("own") && (
          <Button variant="primary" className="mx-1 bg-white text-[#002855] hover:brightness-95" icon={<Plus className="size-4" />} onClick={() => nav("/runs/new")}>
            New run
          </Button>
        )}
        <nav className="flex flex-col gap-0.5">
          {NAV.map((n) => (
            <Item key={n.to} {...n} />
          ))}
        </nav>
        <div>
          <div className="mb-1 px-2.5 text-[10.5px] font-semibold tracking-[0.08em] text-white/50 uppercase">Configuration</div>
          <nav className="flex flex-col gap-0.5">
            {CONFIG.map((n) => (
              <Item key={n.to} {...n} />
            ))}
            {isAdmin && <Item to="/admin" label="Administration" icon={<Shield className="size-4" />} />}
          </nav>
        </div>
        <div className="mt-auto flex items-center gap-1 px-1">
          <DM.Root>
            <DM.Trigger className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-white/10" aria-label="Account menu">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-white/15 text-[12px] font-semibold">{(profile?.full_name || session?.user.email || "?").slice(0, 1).toUpperCase()}</span>
              <span className="min-w-0">
                <span className="block truncate text-[12.5px]">{profile?.full_name || session?.user.email}</span>
                {isAdmin && <span className="block text-[10.5px] text-white/60">Administrator</span>}
              </span>
            </DM.Trigger>
            <DM.Portal>
              <DM.Content side="top" align="start" sideOffset={6} className="z-50 min-w-48 rounded-md border border-line bg-surface p-1 text-[13px] shadow-lg">
                <DM.Item className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2" onSelect={() => nav("/account")}>
                  <User className="size-4" /> Account
                </DM.Item>
                <DM.Item className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2" onSelect={() => signOut()}>
                  <LogOut className="size-4" /> Sign out
                </DM.Item>
              </DM.Content>
            </DM.Portal>
          </DM.Root>
          <button type="button" onClick={nextTheme} className="rounded-md p-2 text-white/70 hover:bg-white/10 hover:text-white" aria-label={`Theme: ${theme}. Switch theme`} title={`Theme: ${theme}`}>
            {theme === "dark" ? <Moon className="size-4" /> : theme === "light" ? <Sun className="size-4" /> : <Monitor className="size-4" />}
          </button>
        </div>
      </aside>
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-6 py-6 outline-none lg:px-8">
        {!clients.length && !clientFree ? <NoClients admin={isAdmin} /> : children}
      </main>
    </div>
  );
}

function NoClients({ admin }: { admin: boolean }) {
  const nav = useNavigate();
  return (
    <div className="mx-auto mt-16 max-w-lg text-center">
      <Gauge className="mx-auto mb-3 size-10 text-muted" />
      <h1 className="mb-2 text-[22px]">No clients yet</h1>
      {admin ? (
        <>
          <p className="mb-4 text-ink-2">Create the first client account. It starts with the spec's SLA baseline and the seed category rules, which you can adjust.</p>
          <Button variant="primary" icon={<Settings2 className="size-4" />} onClick={() => nav("/admin/clients")}>
            Create a client
          </Button>
        </>
      ) : (
        <p className="text-ink-2">
          You haven't been added to a client account yet. Ask an administrator to add you. <Chip>Signed in</Chip>
        </p>
      )}
    </div>
  );
}
