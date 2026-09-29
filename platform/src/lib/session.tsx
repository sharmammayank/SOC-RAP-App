import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase, must } from "./supabase";
import type { Client, ClientRole, Member, Profile } from "./db";

interface SessionValue {
  session: Session | null;
  loading: boolean;
  error: unknown;
  profile: Profile | null;
  clients: Client[];
  memberships: Member[];
  clientId: string | null;
  client: Client | null;
  setClientId: (id: string) => void;
  /** Effective role on the selected client (admins act as owners). */
  role: ClientRole | null;
  isAdmin: boolean;
  can: (action: "own" | "review" | "read", clientId?: string | null) => boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionValue | null>(null);
const LS_KEY = "socrap.client";

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (!s) qc.clear();
    });
    return () => data.subscription.unsubscribe();
  }, [qc]);

  const uid = session?.user.id ?? null;
  const q = useQuery({
    queryKey: ["session-data", uid],
    enabled: !!uid,
    queryFn: async () => {
      const [profile, clients, memberships] = await Promise.all([
        supabase.from("profiles").select("*").eq("id", uid!).maybeSingle(),
        supabase.from("clients").select("*").is("archived_at", null).order("name"),
        supabase.from("client_members").select("*").eq("user_id", uid!),
      ]);
      return { profile: must(profile) as Profile | null, clients: must(clients) as Client[], memberships: must(memberships) as Member[] };
    },
  });

  const [clientId, setClientIdState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LS_KEY);
    } catch {
      return null;
    }
  });
  const clients = useMemo(() => q.data?.clients ?? [], [q.data]);
  const effectiveClientId = clients.some((c) => c.id === clientId) ? clientId : clients[0]?.id ?? null;
  const setClientId = useCallback((id: string) => {
    setClientIdState(id);
    try {
      localStorage.setItem(LS_KEY, id);
    } catch {
      /* private mode: selection lasts for this tab only */
    }
  }, []);

  const isAdmin = !!q.data?.profile?.is_admin;
  const memberships = useMemo(() => q.data?.memberships ?? [], [q.data]);
  const roleFor = useCallback(
    (cid: string | null | undefined): ClientRole | null => (isAdmin ? "owner" : (memberships.find((m) => m.client_id === cid)?.role ?? null)),
    [isAdmin, memberships],
  );
  const can = useCallback(
    (action: "own" | "review" | "read", cid?: string | null) => {
      const r = roleFor(cid === undefined ? effectiveClientId : cid);
      if (!r) return false;
      if (action === "own") return r === "owner";
      if (action === "review") return r === "owner" || r === "reviewer";
      return true;
    },
    [roleFor, effectiveClientId],
  );

  const value: SessionValue = {
    session,
    loading: loading || (!!uid && q.isLoading),
    error: q.error,
    profile: q.data?.profile ?? null,
    clients,
    memberships,
    clientId: effectiveClientId,
    client: clients.find((c) => c.id === effectiveClientId) ?? null,
    setClientId,
    role: roleFor(effectiveClientId),
    isAdmin,
    can,
    refresh: async () => {
      await q.refetch();
    },
    signOut: async () => {
      await supabase.auth.signOut();
      qc.clear();
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession outside SessionProvider");
  return v;
}
