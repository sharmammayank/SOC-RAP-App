# SOC-RAP — production platform

SOC monthly and weekly reporting with SLA analytics and regex-based alert categorization (design spec v2.0).
React 18 + TypeScript + Vite + Tailwind on the front end; Supabase (Postgres with row-level security, Auth, Storage) on the back end.

The calculation engine is a TypeScript port of the validated MVP (`../app.js`). It reproduces the MVP's June 2026 results exactly, across all 160 SLA cells plus volume, category and close-reason figures (`tests/engine.golden.test.ts`).

## Setup

1. **Install:** Node 20+ is required. Run `npm install`.
2. **Configure:** `cp .env.example .env`, then fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from Supabase → Project Settings → API. Use the anon (publishable) key only, never `service_role`.
3. **Create the schema:**
   ```bash
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```
   This applies `supabase/migrations/`: tables, RLS policies, triggers, RPCs, storage buckets and the seed rule set.
4. **Configure Auth** in Supabase → Authentication:
   - **URL Configuration:** set the site URL (for example `http://localhost:5173`) and add your deployed URL as a redirect.
   - **Providers → Email:** turn on. Turn off "Allow new users to sign up" once your first user exists; the app is invite-only.
   - **Optional, Microsoft Entra ID (spec §3.1):** enable the Azure provider with your tenant URL, client ID and secret, then set `VITE_AUTH_AZURE_ENABLED=true`.
5. **Create the first user:** Supabase → Authentication → Users → Add user. **The first account created becomes the administrator.** Sign in, open Administration → Clients and create a client. New clients start from SLA baseline SEP-2026-SLA-01 and a copy of the seed rule set.
6. **Optional, invite emails from the app:** `npx supabase functions deploy admin-invite`, and set `APP_ORIGINS=https://your.app.url` as a function secret. Without it, invite people from the Supabase dashboard and add them to clients in the app.
7. **Run:** `npm run dev` for local development; `npm run build` produces static files in `dist/` for any static host (Vercel, Netlify, Azure Static Web Apps, S3 + CloudFront). Serve `index.html` for all routes.

## How it works

| Spec | Where |
|---|---|
| §3.2 pipeline: upload → map → stage → classify → validate → review → calculate → publish | `src/lib/runService.ts`, `src/pages/NewRunPage.tsx`, `src/pages/RunPage.tsx` |
| M2 SLA configuration: units, "= N seconds" preview, targets, immutable versions, clone | `src/pages/SlaConfigPage.tsx`, table `threshold_versions` |
| M3 regex rule engine: precedence, longest-match ties, audit mode, fallback, draft/publish, regression + diff, JSON import/export | `src/engine/rules.ts`, `src/pages/RulesPage.tsx` |
| M4 ingestion: safe XLSX/CSV reader, header detection, column profiles, duplicate-hash prompt | `src/engine/ingest.ts`, `src/engine/xlsx/*`, `src/workers/parse.worker.ts` |
| M5 exceptions: grouped queue, bulk actions, inline edits, promote-to-rule, readiness banner | `src/engine/run.ts`, `src/features/run/ReviewQueue.tsx` |
| M6 calculation: MET / NOT MET / PENDING / N/A / DATA ERROR, compliance, mean, median, P95, worst five | `src/engine/run.ts`, `src/engine/aggregate.ts` |
| M7 heatmaps: time window, granularity, filters, drill-through, PNG/CSV | `src/engine/analytics.ts`, `src/pages/AnalyticsPage.tsx` |
| M8 comparison: previous / prior-year / chosen baseline, trendline, traceable observations | `src/engine/analytics.ts`, `src/pages/ComparePage.tsx` |
| M9 exports: workbook, exception report with reconciliation, slide tables, PowerPoint deck | `src/engine/export/workbook.ts`, `src/lib/deck.ts` |
| M10 administration: clients, users and roles, audit log, versions, retention purge | `src/pages/AdminPage.tsx` |

**Where the processing runs:** the browser. The engine runs in the client and in a Web Worker. It doesn't run in Edge Functions, whose CPU limits suit a 100,000-row run poorly.

**What the database guarantees:**
- Raw rows are insert-only.
- The edit log is append-only, recording the original value, the new value, who and when.
- Threshold versions and published rule sets are immutable.
- Publishing goes through `publish_run()`, which refuses while any blocking exception is open or the compliance snapshot is missing. It also supersedes earlier runs for the same period.
- A published run is locked by triggers.
- Each run records its source hash, threshold version, rule-set version and engine version. Its Results page recalculates the run and shows whether that matches the published snapshot (AT-12).

**Roles, per client:**
- **Owner** (reporting owner): runs, publishing, SLA and rules for that client.
- **Reviewer:** resolves exceptions.
- **Viewer:** read-only.
- **Administrator:** a global role with access to every client, plus user management and purges.

## Tests

```bash
npm test          # engine: golden parity with the MVP and deck, spec AT-01…AT-12, security cases
npm run test:db   # migrations + RLS/trigger tests on a throwaway local Postgres (51 checks)
npm run lint && npm run typecheck
```

Golden tests read `tests/fixtures/june.xlsx` and `july.xlsx`. They're git-ignored because they're client data; copy them in to run those tests.

## Known limits and next steps

- **Regex safety:** patterns go through a backtracking-safety gate (`checkPattern`), and titles are capped at 1,024 characters. Browser JavaScript can't enforce the spec's 50 ms per-pattern timeout. Uploads are parsed in a Web Worker with a watchdog.
- **Trust model:** derived results are computed client-side by authorized owners and reviewers, and are fully reproducible from the immutable raw rows and edits. A server-side recompute check at publish time (an Edge Function or scheduled job) would add independent verification.
- **Scale:** analytics read `case_derived` rows over PostgREST in pages. That's fine for typical monthly volumes (thousands of rows). For sustained 100k-row periods, add SQL aggregate RPCs or materialized snapshots.
- **Business-hours calendars and phase-to-phase measurement** (spec §5.1 options) aren't implemented; measurement is creation-to-milestone, 24×7, as in the MVP.
