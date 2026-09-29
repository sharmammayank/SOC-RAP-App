import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigured = !!(url && key && /^https?:\/\//.test(url) && !url.includes("YOUR-PROJECT-REF"));
export const azureEnabled = import.meta.env.VITE_AUTH_AZURE_ENABLED === "true";

/** Throws a readable error when the environment isn't configured; the App shows a setup screen instead of calling this. */
export const supabase: SupabaseClient = supabaseConfigured
  ? createClient(url!, key!, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" } })
  : (new Proxy({}, { get: () => { throw new Error("Supabase isn't configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env."); } }) as SupabaseClient);

/** Unwraps a Supabase response, throwing its error with a readable message. */
export function must<T>(r: { data: T; error: { message: string; details?: string | null; hint?: string | null } | null }): T {
  if (r.error) throw new Error(r.error.message + (r.error.hint ? ` (${r.error.hint})` : ""));
  return r.data;
}

/** Reads every row of a query in pages (PostgREST returns at most 1,000 per request by default). */
export async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>, pageSize = 1000, onPage?: (n: number) => void): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    onPage?.(out.length);
    if (!data || data.length < pageSize) break;
  }
  return out;
}

/** Runs async work over items in batches with limited concurrency. */
export async function inBatches<T>(items: T[], size: number, fn: (batch: T[], i: number) => Promise<void>, concurrency = 3, onProgress?: (done: number) => void) {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  let next = 0,
    done = 0;
  const worker = async () => {
    while (next < batches.length) {
      const i = next++;
      await fn(batches[i], i);
      done += batches[i].length;
      onProgress?.(done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
}
