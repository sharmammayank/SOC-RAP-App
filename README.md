# SOC-RAP — SOC Reporting & Analytics Platform

**Turn raw SOC case exports into audit-ready SLA reports, Excel workbooks and client-ready PowerPoint decks in minutes instead of days.**

SOC-RAP automates the monthly and weekly service-review reporting that Security Operations Centres owe their clients. It ingests case exports, measures every case against the client's contracted SLAs, categorizes alerts with a governed rule engine, surfaces data-quality problems for review, and produces consistent, traceable deliverables.

---

## Table of contents

1. [The problem](#1-the-problem)
2. [The solution](#2-the-solution)
3. [Business value and time saved](#3-business-value-and-time-saved)
4. [Key capabilities](#4-key-capabilities)
5. [Editions](#5-editions)
6. [Architecture](#6-architecture)
7. [Getting started: local app](#7-getting-started-local-app)
8. [Getting started: production platform](#8-getting-started-production-platform)
9. [Configuration reference](#9-configuration-reference)
10. [Roles and access](#10-roles-and-access)
11. [Data integrity and governance](#11-data-integrity-and-governance)
12. [Security by design](#12-security-by-design)
13. [Testing and quality](#13-testing-and-quality)
14. [Repository layout](#14-repository-layout)
15. [Roadmap](#15-roadmap)
16. [Licence](#16-licence)

---

## 1. The problem

Every month, and often every week, a managed SOC must show each client how well it met its contractual SLAs. In most teams this is still done by hand in spreadsheets, and it hurts in several ways:

| Pain point | What it looks like in practice | Impact |
|---|---|---|
| **Manual SLA arithmetic** | Analysts subtract timestamps cell by cell for four metrics (acknowledge, investigate, contain, remediate) across four priorities, then work out compliance %, averages, medians and P95s. | Hours of repetitive work per client, and formula errors that are hard to spot. |
| **Inconsistent alert categorization** | Each analyst buckets alert titles differently, and the "rules" live in someone's head or in a fragile lookup sheet. | Category trends that change because the person changed, not because the threats did. |
| **Dirty source data** | Exports arrive with missing or out-of-order timestamps, unknown priorities, renamed columns and duplicate files. | Problems are found late, sometimes by the client, forcing rework and eroding trust. |
| **Slide and workbook assembly** | Numbers are copied by hand from spreadsheets into Excel templates and PowerPoint decks. | Copy-paste errors, inconsistent formatting, and senior analyst time spent on formatting. |
| **No audit trail** | Nobody can say which data, SLA thresholds or categorization rules produced last month's numbers. | Disputed figures can't be defended, and results can't be reproduced. |
| **Doesn't scale** | Every new client adds another spreadsheet, another template and another reporting day. | Reporting headcount grows linearly with the client base. |

The result: skilled security analysts lose a large part of every reporting cycle to clerical work, reports arrive late, and the numbers are only as reliable as the last manual check.

## 2. The solution

SOC-RAP replaces the spreadsheet workflow with a single, repeatable pipeline:

```
upload → map columns → classify alerts → validate data → review exceptions → calculate SLAs → publish → export
```

| Pain point | How SOC-RAP solves it |
|---|---|
| Manual SLA arithmetic | Every case is measured automatically against per-priority limits for **TTA, TTI, TTC and TTR**. Compliance %, mean, median, P95 and the five worst cases are calculated for every priority × metric cell. |
| Inconsistent categorization | A **versioned regex rule engine** assigns category, subcategory and report bucket, with precedence, longest-match tie-breaking, regression checks and draft/publish control. |
| Dirty source data | Data problems are **flagged before calculation** in a review queue, with inline and bulk fixes, and fixes can be promoted into new rules. |
| Slide and workbook assembly | **One-click Excel workbook and PowerPoint deck**, generated from the same calculated results every time. |
| No audit trail | Every run records its source-file hash, SLA version, rule-set version and engine version. Edits are logged with before/after values, and published results can be recalculated and verified. |
| Doesn't scale | **Multi-client** from the start: per-client SLA profiles, rule sets, roles and isolated data. Adding a client is configuration, not a new spreadsheet. |

## 3. Business value and time saved

### Estimated time saved per week

The figures below are **planning estimates** for one reporting analyst, based on a typical manual spreadsheet workflow. Actual savings depend on case volume, data quality and report complexity, so measure your own baseline before and after adoption.

| Reporting task (per client, per cycle) | Manual effort | With SOC-RAP | Saved |
|---|---|---|---|
| Cleaning and reformatting the export | 45 min | 5 min (automatic mapping) | 40 min |
| Finding and fixing data problems | 60 min | 15 min (guided review queue) | 45 min |
| Categorizing alerts | 60 min | 2 min (rule engine) | 58 min |
| Calculating SLA metrics and compliance | 90 min | 1 min (automatic) | 89 min |
| Building the Excel workbook | 45 min | 1 min (one click) | 44 min |
| Building the PowerPoint deck | 60 min | 5 min (one click, then review) | 55 min |
| Checking and reconciling the numbers | 30 min | 5 min (built-in reconciliation) | 25 min |
| **Total per client, per cycle** | **~6.5 h** | **~0.5 h** | **~6 h** |

**What that means per week:**

| Workload | Reports per week | Manual effort | With SOC-RAP | **Time saved per week** |
|---|---|---|---|---|
| 1 client, weekly reports | 1 | ~6.5 h | ~0.5 h | **~6 h** |
| 3 clients, weekly reports | 3 | ~19.5 h | ~1.5 h | **~18 h** |
| 5 clients, weekly reports | 5 | ~32.5 h | ~2.5 h | **~30 h** |
| 10 clients, monthly reports (≈2.3 per week) | 2.3 | ~15 h | ~1.2 h | **~14 h** |

For a team reporting weekly on three clients, that is roughly **18 analyst hours a week**, or about **two and a half working days**, returned to detection, investigation and threat hunting.

### Value beyond time

- **Accuracy:** one tested calculation engine replaces hand-built formulas.
- **Consistency:** every client and every period is reported the same way.
- **Defensibility:** any published number can be traced to its source file, SLA version and rule version, and recalculated on demand.
- **Faster delivery:** reports reach clients sooner in the cycle.
- **Scalability:** new clients are onboarded through configuration, not extra headcount.
- **Early warning:** trends, heatmaps and period comparisons show SLA drift before it becomes a breach.

## 4. Key capabilities

### SLA measurement

Each case is measured from creation to four milestones, 24×7:

| Metric | Name | Measured to |
|---|---|---|
| **TTA** | Time to Acknowledge | Assigned / acknowledged |
| **TTI** | Time to Investigate | End of investigation |
| **TTC** | Time to Contain | Containment |
| **TTR** | Time to Remediate | Closure |

Each case/metric pair gets one status: **MET**, **NOT MET**, **PENDING**, **N/A** or **DATA ERROR**. Every priority × metric cell reports compliance %, mean, median, P95 and the five worst cases.

### Alert categorization

- Regex rules assign **category, subcategory and report bucket** to every alert title.
- Precedence ordering, with the longest match winning ties.
- Audit mode, fallback category and draft/publish versioning.
- Regression checks with a before/after diff before a rule set is published.
- JSON import/export for sharing rule sets between clients.
- Every pattern passes an automated safety check before it can run.

### Data ingestion and review

- Accepts `.xlsx` and `.csv` exports.
- Detects the header row and maps columns to a standard schema. Common names such as `Created`, `Closed At` and `Severity` are recognized automatically.
- Flags missing timestamps, out-of-order timestamps, unknown priorities and duplicate files.
- Fix issues inline or in bulk, or turn a fix into a reusable rule.

### Reporting and analytics

- **Excel workbook:** SLA tables, volumes, categories, close reasons, and an exception report with reconciliation.
- **PowerPoint deck:** slide-ready tables and charts.
- **Heatmaps** *(platform)*: time window, granularity, filters, drill-through, and PNG/CSV export.
- **Period comparison** *(platform)*: previous month, prior year or a chosen baseline, with trendlines.

## 5. Editions

The repository contains two editions built on the same calculation engine:

| | **Local app** | **Production platform** |
|---|---|---|
| Folder | repository root | [`platform/`](platform/) |
| Best for | One analyst on one computer | Teams serving several clients |
| Storage | Browser storage on the local machine | Supabase (Postgres, Auth, Storage) |
| Sign-in | None needed | Invite-only email, optional Microsoft Entra ID |
| Setup time | About 1 minute | About 30 minutes |
| Requirements | Python 3 and a modern browser | Node.js 20+ and a Supabase project |

The platform engine is a TypeScript port of the local app's engine, and golden tests confirm both produce identical results.

## 6. Architecture

**Local app**

```
Browser (index.html + app.js)  ◄──  server.py (127.0.0.1 only, static files)
        │
        └── Browser storage (data never leaves the machine)
```

**Production platform**

```
Browser: React UI + Web Worker (parsing and calculation engine)
        │  HTTPS, authenticated session
        ▼
Supabase: Postgres (row-level security, triggers, RPCs)
          Auth (email invites, optional Microsoft Entra ID)
          Storage (private buckets for uploads and generated reports)
          Edge Function: admin-invite
```

The calculation engine runs in the browser and a Web Worker, which keeps large runs responsive and avoids server CPU limits.

**Tech stack**

| Layer | Technologies |
|---|---|
| Front end | React 18, TypeScript, Vite, Tailwind CSS 4, TanStack Query, React Router, Radix UI, ECharts, PptxGenJS, Zod |
| Back end | Supabase: Postgres with row-level security, Auth, Storage, Edge Functions (Deno) |
| Quality | Vitest, embedded Postgres for database tests, ESLint, TypeScript strict type checking |

## 7. Getting started: local app

**Requirements:** Python 3 and a modern browser (Chrome, Edge, Firefox or Safari).

| Platform | How to start |
|---|---|
| macOS | Double-click `start.command`. The app opens at **http://localhost:8731**. If macOS says it can't verify the file, right-click it, choose **Open**, then **Open** again (first time only). |
| Windows | Double-click `start.bat`, then open **http://localhost:8731**. |
| Any OS | From the repository folder, run the command below. |

```bash
python3 server.py
```

Keep the terminal window open while you use the app, and press **Ctrl+C** to stop it.

**First report in three steps:**

1. Choose **+ New client**, or upload a file and name the client when asked.
2. On the **Data** tab, upload the period's case export (`.xlsx` or `.csv`). When you upload the next period, it is added and compared automatically.
3. Resolve any flagged items, then choose **Download Excel** or **Download PowerPoint**.

> **Note:** Data is saved in the browser for the exact address `http://localhost:8731`. Using a different browser or port shows an empty workspace.

## 8. Getting started: production platform

**Requirements:** Node.js 20+, a Supabase project, and the Supabase CLI (run through `npx`).

### Step 1: Install

```bash
cd platform
npm install
```

### Step 2: Configure the environment

```bash
cp .env.example .env
```

Fill in the values described in [Front-end environment variables](#91-front-end-environment-variables-platformenv).

### Step 3: Create the database schema

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

This applies everything in `supabase/migrations/`: tables, row-level security policies, triggers, RPCs, storage buckets and the seed rule set.

### Step 4: Configure authentication

In the Supabase dashboard, open **Authentication** and follow [Authentication settings](#93-authentication-settings-supabase-dashboard).

### Step 5: Create the first administrator

In **Supabase → Authentication → Users**, choose **Add user**. **The first account created becomes the platform administrator.** Sign in, open **Administration → Clients** and create your first client. New clients start from SLA baseline **SEP-2026-SLA-01** and a copy of the seed rule set.

### Step 6 (optional): Enable in-app invitations

```bash
npx supabase functions deploy admin-invite
npx supabase secrets set APP_ORIGINS=https://your-app-domain.example
```

Without this, invite users from the Supabase dashboard and add them to clients in the app.

### Step 7: Run or deploy

```bash
npm run dev        # local development at http://localhost:5173
npm run build      # production build in dist/
```

The `dist/` folder can be served by any static host, such as Vercel, Netlify, Azure Static Web Apps, or S3 with CloudFront. Configure the host to serve `index.html` for every route.

## 9. Configuration reference

> **Never commit real credentials.** `.env` files are git-ignored. Only placeholder values belong in `.env.example`.

### 9.1 Front-end environment variables (`platform/.env`)

| Variable | Required | Description | Where to find it |
|---|---|---|---|
| `VITE_SUPABASE_URL` | Yes | Your Supabase project URL, e.g. `https://<project-ref>.supabase.co` | Supabase → Project Settings → API |
| `VITE_SUPABASE_ANON_KEY` | Yes | The public **anon / publishable** key. This key is designed to be used in the browser; access is enforced by row-level security. | Supabase → Project Settings → API |
| `VITE_AUTH_AZURE_ENABLED` | No | `true` shows the **Sign in with Microsoft** button. Default `false`. | Set to `true` after enabling the Azure provider |

> Only the anon/publishable key belongs in the front end. Privileged keys must never be placed in `.env` or any `VITE_` variable, because those values are shipped to the browser.

### 9.2 Edge Function secrets (`admin-invite`)

| Secret | Required | Description |
|---|---|---|
| `APP_ORIGINS` | Strongly recommended | Comma-separated list of allowed app origins (for example `https://reports.example.com`). When set, browser requests from any other origin are refused. Always set it in production. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Automatic | Provided by Supabase to the function at runtime. Do not set them by hand, and never expose the service-role key outside the function. |

Set secrets with `npx supabase secrets set NAME=value`.

### 9.3 Authentication settings (Supabase dashboard)

| Setting | Location | Recommended value |
|---|---|---|
| Site URL | Authentication → URL Configuration | Your app URL (`http://localhost:5173` for development) |
| Redirect URLs | Authentication → URL Configuration | Every URL the app is served from |
| Email provider | Authentication → Providers → Email | Enabled |
| Allow new users to sign up | Authentication → Providers → Email | **Disabled** once the first administrator exists (the platform is invite-only) |
| Microsoft Entra ID *(optional)* | Authentication → Providers → Azure | Enabled with your tenant URL, client ID and client secret, then set `VITE_AUTH_AZURE_ENABLED=true` |

### 9.4 Local Supabase development (`platform/supabase/config.toml`)

| Setting | Default | Purpose |
|---|---|---|
| `project_id` | `soc-rap` | Name of the local Supabase stack |
| `[api] port` | `54321` | Local API port |
| `[api] max_rows` | `1000` | Maximum rows per API response |
| `[db] port` | `54322` | Local Postgres port |
| `[auth] site_url` | `http://localhost:5173` | Default redirect for local development |
| `[auth] jwt_expiry` | `3600` | Session token lifetime in seconds (1 hour) |
| `[auth] minimum_password_length` | `12` | Minimum password length |
| `[storage] file_size_limit` | `50MiB` | Maximum upload size for local development |

### 9.5 Storage buckets (created by migrations)

| Bucket | Access | Size limit | Contents |
|---|---|---|---|
| `uploads` | Private, per-client policies | 100 MB | Source case exports (`.xlsx`, `.csv`) |
| `artifacts` | Private, per-client policies | 100 MB | Generated workbooks and decks |

### 9.6 SLA configuration (in the app)

SLA limits and compliance targets are configured per client, per priority and per metric under **SLA configuration**. Limits can be entered in seconds, minutes or hours, must be whole seconds, and can be at most 30 days. Targets are percentages from 0 to 100 with up to one decimal place. Saved versions are immutable; to change them, clone the version and edit the copy. The app warns if TTA is longer than TTI, or TTC is longer than TTR.

The seed baseline **SEP-2026-SLA-01** is:

| Priority | TTA | TTI | TTC | TTR | Compliance target |
|---|---|---|---|---|---|
| Critical | 30 min | 1 h | 4 h | 16 h | 98% |
| High | 1 h | 2 h | 8 h | 20 h | 97% (TTR 95%) |
| Medium | 8 h | 4 h | 12 h | 24 h | 90% |
| Low | 12 h | 8 h | 24 h | 72 h | 90% |

### 9.7 Categorization rules (in the app)

Rule sets are managed per client under **Rules**. Each rule has a regex pattern, a precedence, and the category, subcategory and report bucket to assign. Draft changes are regression-tested against earlier runs and shown as a diff before publishing. Published rule sets are immutable, and rule sets can be exported and imported as JSON.

### 9.8 Local app settings

| Variable | Default | Description |
|---|---|---|
| `SOC_RAP_PORT` | `8731` | Port for the local server. Saved data is tied to the port, so keep it the same between sessions. |

```bash
SOC_RAP_PORT=9000 python3 server.py
```

### 9.9 Processing limits

| Limit | Value |
|---|---|
| Maximum rows per upload | 500,000 |
| Maximum SLA limit | 30 days |
| Supported formats | `.xlsx`, `.csv` |

### 9.10 npm scripts (`platform/`)

| Script | Purpose |
|---|---|
| `npm run dev` | Start the development server |
| `npm run build` | Type-check and build for production |
| `npm run preview` | Preview the production build locally |
| `npm test` | Run engine, acceptance and security tests |
| `npm run test:db` | Run migrations and database policy tests on a temporary Postgres |
| `npm run lint` | Lint the code |
| `npm run typecheck` | Type-check without building |
| `npm run db:push` | Apply migrations to the linked Supabase project |
| `npm run db:types` | Regenerate database TypeScript types |

## 10. Roles and access

Access is granted per client, so a user can hold different roles for different clients.

| Role | Permissions |
|---|---|
| **Owner** | Create and publish runs; manage the client's SLA settings and rules |
| **Reviewer** | Review and resolve data exceptions |
| **Viewer** | Read-only access to published results |
| **Administrator** *(global)* | Everything on every client, plus user management, audit log and retention purges |

## 11. Data integrity and governance

These guarantees are enforced in the database, not just the user interface:

- **Immutable source data:** raw case rows are insert-only.
- **Complete edit history:** the edit log is append-only and records the old value, the new value, who made the change and when.
- **Versioned configuration:** SLA threshold versions and published rule sets can't be changed after they are saved.
- **Controlled publishing:** a run can't be published while any blocking exception is open, and publishing supersedes earlier runs for the same period.
- **Locked results:** published runs are protected against change.
- **Reproducibility:** each run records its source-file hash, SLA version, rule-set version and engine version, and the Results page can recalculate a run to confirm it matches the published snapshot.
- **Accountable retention:** data purges are restricted to administrators and always logged with a reason.

## 12. Security by design

SOC-RAP handles sensitive security operations data, and it is built accordingly:

- **Least-privilege access:** every table is protected by per-client row-level security, backed by automated policy tests.
- **Invite-only sign-in:** public sign-up is disabled in production, with optional single sign-on through Microsoft Entra ID.
- **Credential separation:** the browser only receives the public anon key; privileged keys stay server-side in the Edge Function environment.
- **Safe file handling:** uploads are parsed by a hardened reader in an isolated Web Worker with size and structure checks.
- **Safe exports:** generated spreadsheets neutralize formula injection.
- **Rule safety:** regex patterns are screened before they can run.
- **Local-only mode:** the local app binds to `127.0.0.1`, serves only its own files, accepts only read requests, and sends strict security headers. Case data stays in the browser on that machine.
- **Pinned dependencies:** bundled third-party libraries are pinned and integrity-checked.

Please report suspected vulnerabilities privately to the repository owner rather than opening a public issue.

## 13. Testing and quality

```bash
cd platform
npm test                            # engine parity, acceptance tests AT-01 to AT-12, security cases
npm run test:db                     # migrations and row-level security / trigger tests
npm run lint && npm run typecheck   # static checks
```

- **Golden parity tests** confirm the platform engine matches the local app's results across every SLA cell, plus volume, category and close-reason figures.
- **Acceptance tests** (AT-01 to AT-12) cover the full specification.
- **Database tests** verify row-level security isolation and trigger protections.

> The golden tests use sample export files in `platform/tests/fixtures/`. These contain operational data, so they are git-ignored and not included in the repository. Supply your own fixtures locally to run those tests.

## 14. Repository layout

```
SOC-RAP-App/
├── index.html, app.js         Local app: single-page UI and calculation engine
├── vendor/                    Pinned third-party library (PptxGenJS, MIT)
├── server.py                  Hardened local web server (127.0.0.1 only)
├── start.command / start.bat  One-click start for macOS / Windows
└── platform/                  Production platform
    ├── src/
    │   ├── engine/            Ingest, mapping, rules, run, aggregate, analytics, export
    │   ├── pages/             Dashboard, New run, Run, SLA config, Rules, Analytics, Compare, Exports, Admin
    │   ├── features/run/      Review queue, cases, results, publish, activity, exports
    │   ├── components/        UI primitives, charts, heatmap, layout
    │   ├── lib/               Supabase client, services, session, report and deck generation
    │   └── workers/           Web Worker for parsing uploads
    ├── supabase/
    │   ├── migrations/        Schema, security policies, triggers, RPCs, seed rules
    │   ├── functions/         admin-invite Edge Function
    │   └── tests/             Database policy and trigger tests
    ├── tests/                 Engine, acceptance and security tests
    └── scripts/               Database test runner
```

## 15. Roadmap

- Business-hours SLA calendars and phase-to-phase measurement (today's measurement is creation-to-milestone, 24×7).
- Server-side recalculation at publish time for independent verification.
- SQL aggregate functions for faster analytics on very large periods.

## 16. Licence

No licence has been chosen for this project yet; all rights are reserved by the owner. Third-party components keep their own licences (see `vendor/PptxGenJS-LICENSE.txt`, MIT).
