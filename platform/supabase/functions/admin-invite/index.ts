// Invites a user by email and optionally grants client access. Callable only by administrators.
// Deploy: npx supabase functions deploy admin-invite
// The service-role key is available to Edge Functions automatically and never reaches the browser.
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = (Deno.env.get("APP_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function cors(origin: string | null) {
  const allow = origin && (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) ? origin : ALLOWED_ORIGINS[0] ?? "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}
const json = (body: unknown, status: number, h: Record<string, string>) => new Response(JSON.stringify(body), { status, headers: { ...h, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const h = cors(req.headers.get("Origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const auth = req.headers.get("Authorization") ?? "";
  // Identify the caller with their own token, then check administrator status in the database.
  const asCaller = createClient(url, anon, { global: { headers: { Authorization: auth } } });
  const { data: me, error: meErr } = await asCaller.auth.getUser();
  if (meErr || !me.user) return json({ error: "Sign in again." }, 401, h);
  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { data: prof } = await admin.from("profiles").select("is_admin").eq("id", me.user.id).maybeSingle();
  if (!prof?.is_admin) return json({ error: "Only administrators can invite users." }, 403, h);

  let body: { email?: string; full_name?: string; client_id?: string | null; role?: string; is_admin?: boolean; redirect_to?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request." }, 400, h);
  }
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json({ error: "Enter a valid email address." }, 400, h);
  const role = body.role ?? "reviewer";
  if (!["owner", "reviewer", "viewer"].includes(role)) return json({ error: "Unknown role." }, 400, h);
  const redirectTo = body.redirect_to && (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(body.redirect_to)) ? body.redirect_to : undefined;

  const { data: inv, error } = await admin.auth.admin.inviteUserByEmail(email, { data: { full_name: String(body.full_name ?? "").slice(0, 120) }, redirectTo });
  let userId = inv?.user?.id;
  if (error) {
    // Already registered: look the user up and just grant access.
    const { data: existing } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
    if (!existing) return json({ error: error.message }, 400, h);
    userId = existing.id;
  }
  if (!userId) return json({ error: "The invitation couldn't be created." }, 500, h);
  if (body.is_admin) await admin.from("profiles").update({ is_admin: true }).eq("id", userId);
  if (body.client_id) {
    const { error: mErr } = await admin.from("client_members").upsert({ client_id: body.client_id, user_id: userId, role, added_by: me.user.id });
    if (mErr) return json({ error: mErr.message }, 400, h);
  }
  await admin.from("audit_log").insert({ client_id: body.client_id ?? null, actor: me.user.id, action: "User invited", entity: "profile", entity_id: userId, detail: { email, role: body.client_id ? role : null, is_admin: !!body.is_admin } });
  return json({ ok: true, user_id: userId }, 200, h);
});
