export function SetupPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <div className="eyebrow mb-2">SOC-RAP setup</div>
      <h1 className="mb-3 text-[26px]">Connect the app to Supabase</h1>
      <p className="mb-6 text-ink-2">The app can't find its Supabase settings. Add them once and restart the dev server.</p>
      <ol className="list-decimal space-y-3 pl-5 text-[14px]">
        <li>
          Copy <code className="font-mono text-[13px]">.env.example</code> to <code className="font-mono text-[13px]">.env</code> in the <code className="font-mono text-[13px]">platform</code> folder.
        </li>
        <li>
          In Supabase, open <b>Project Settings → API</b> and paste the <b>Project URL</b> into <code className="font-mono text-[13px]">VITE_SUPABASE_URL</code> and the <b>anon / publishable key</b> into{" "}
          <code className="font-mono text-[13px]">VITE_SUPABASE_ANON_KEY</code>. Never use the service_role key here.
        </li>
        <li>
          Apply the database schema: <code className="font-mono text-[13px]">npx supabase link --project-ref &lt;ref&gt;</code> then <code className="font-mono text-[13px]">npx supabase db push</code>.
        </li>
        <li>
          Restart with <code className="font-mono text-[13px]">npm run dev</code>.
        </li>
      </ol>
      <p className="mt-6 text-[13px] text-muted">The README in the platform folder has the full checklist, including Microsoft Entra ID sign-in.</p>
    </main>
  );
}
